// src/shell/capture.ts —— shell exec 的有界输出视图（spec §3.2）。
//
// 为什么自建：上游的 `OutputCapture` 类在 pi-agent-core 0.85.1 **没有导出入口**（只导出
// `applyShellOutputUpdate`/`shell-output`/`truncate` 工具），Global Constraints 禁 deep import。
// 语义按上游对齐：默认尾保留、行/字节双上限先到先触发、增量更新按 replace/append/slide/metadata 交付
// （消费方用 applyShellOutputUpdate 累积出同一个视图）。
import {
	DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, sanitizeBinaryOutput, truncateHead, truncateTail, utf8ByteLength,
	type Context, type ShellOutputLimits, type ShellOutputMetadata, type ShellOutputRetention,
	type ShellOutputUpdate, type ShellOutputView,
} from '@earendil-works/pi-agent-core';

/** 输出变化的回调签名（上游 OutputCapture 的 onUpdate 同参：update + context） */
export type ShellExecUpdateCallback = (update: ShellOutputUpdate, context: Context) => void;

/** 窗口收缩的宽容倍数：窗口涨到上限的 4 倍才裁（裁一次是 O(窗口)，每字节都裁会把大输出跑成 O(n²)） */
const WINDOW_SLACK = 4;

export interface ShellCaptureOptions {
	limits?: ShellOutputLimits;
	/** 输出变化回调（按上游四态透传） */
	onUpdate?: ShellExecUpdateCallback;
	/** 传给 onUpdate 的 chord Context（与上游 OutputCapture 同参） */
	context: Context;
}

export class ShellCapture {
	readonly #maxBytes: number;
	readonly #maxLines: number;
	readonly #retain: ShellOutputRetention;
	readonly #onUpdate: ShellExecUpdateCallback | undefined;
	readonly #context: Context;
	readonly #decoder = new TextDecoder();
	/** 保留窗口（尾保留时是最后一段，头保留时是开头一段） */
	#window = '';
	#windowBytes = 0;
	/** 全量计数：窗口会被裁，总数只能增量记 */
	#totalBytes = 0;
	#newlines = 0;
	#endsWithNewline = true;
	#currentLineBytes = 0;
	#view: ShellOutputView | undefined;

	constructor(options: ShellCaptureOptions) {
		// 上限缺省取上游默认（50KB / 2000 行）；保留端默认尾保留
		this.#maxBytes = options.limits?.maxBytes ?? DEFAULT_MAX_BYTES;
		this.#maxLines = options.limits?.maxLines ?? DEFAULT_MAX_LINES;
		this.#retain = options.limits?.retain ?? 'tail';
		this.#onUpdate = options.onUpdate;
		this.#context = options.context;
	}

	/** 喂一段原始输出（stdout/stderr **合并**：上游 Node 实现同样把两路喂进一个 capture 视图） */
	push(bytes: Uint8Array): void {
		this.#append(this.#decoder.decode(bytes, { stream: true }));
	}

	/** 收尾：刷掉解码器里未成形的尾部字节并发布最终视图（超时/中止路径也要调，保住已产生的输出） */
	finish(): void {
		this.#append(this.#decoder.decode());
	}

	/** 结果元数据（ShellExecResult 的 truncation/spillPath/lastLineBytes） */
	metadata(): ShellOutputMetadata {
		const { truncation, spillPath, lastLineBytes } = this.#snapshot();
		return { truncation, ...(spillPath === undefined ? {} : { spillPath }), ...(lastLineBytes === undefined ? {} : { lastLineBytes }) };
	}

	#totalLines(): number {
		return this.#newlines + (this.#endsWithNewline || this.#totalBytes === 0 ? 0 : 1);
	}

	#append(text: string): void {
		if (text === '') return;
		const bytes = utf8ByteLength(text);
		this.#totalBytes += bytes;
		this.#newlines += countNewlines(text);
		this.#endsWithNewline = text.endsWith('\n');
		const lastNewline = text.lastIndexOf('\n');
		this.#currentLineBytes = lastNewline === -1 ? this.#currentLineBytes + bytes : utf8ByteLength(text.slice(lastNewline + 1));
		// 头保留：窗口涨满之后新内容不再进窗口（计数照记）；尾保留：继续追加，随后裁窗口
		if (!(this.#retain === 'head' && this.#windowBytes >= this.#maxBytes)) {
			this.#window += text;
			this.#windowBytes += bytes;
		}
		if (this.#windowBytes > this.#maxBytes * WINDOW_SLACK) {
			const keep = { maxBytes: this.#maxBytes * 2, maxLines: this.#maxLines * 2 };
			this.#window = (this.#retain === 'head' ? truncateHead(this.#window, keep) : truncateTail(this.#window, keep)).content;
			this.#windowBytes = utf8ByteLength(this.#window);
		}
		this.#publish();
	}

	#snapshot(): ShellOutputView {
		const limits = { maxBytes: this.#maxBytes, maxLines: this.#maxLines };
		const retained = this.#retain === 'head' ? truncateHead(this.#window, limits) : truncateTail(this.#window, limits);
		const totalLines = this.#totalLines();
		const truncated = this.#totalBytes > this.#maxBytes || totalLines > this.#maxLines;
		const { content, ...truncation } = retained;
		return {
			// 控制字符按上游净化（\r\x1b 一类进不了输出视图）
			text: sanitizeBinaryOutput(content),
			truncation: {
				...truncation,
				truncated,
				truncatedBy: truncated ? (totalLines > this.#maxLines ? 'lines' : 'bytes') : null,
				totalBytes: this.#totalBytes,
				totalLines,
			},
			...(retained.lastLinePartial ? { lastLineBytes: this.#currentLineBytes } : {}),
		};
	}

	#publish(): void {
		const next = this.#snapshot();
		const previous = this.#view;
		this.#view = next;
		if (!this.#onUpdate) return;
		this.#onUpdate(updateFrom(previous, next), this.#context);
	}
}

/** 上一个视图 → 本次视图的增量（上游同形：能表达成 append/slide 就不整段 replace） */
function updateFrom(previous: ShellOutputView | undefined, current: ShellOutputView): ShellOutputUpdate {
	const metadata: ShellOutputMetadata = {
		truncation: current.truncation,
		...(current.spillPath === undefined ? {} : { spillPath: current.spillPath }),
		...(current.lastLineBytes === undefined ? {} : { lastLineBytes: current.lastLineBytes }),
	};
	if (!previous) return { kind: 'replace', output: current };
	if (current.text === previous.text) return { kind: 'metadata', metadata };
	if (current.text.startsWith(previous.text)) return { kind: 'append', text: current.text.slice(previous.text.length), metadata };
	const shared = suffixPrefixOverlap(previous.text, current.text, Math.min(previous.text.length, current.text.length, current.truncation.maxBytes * 2));
	if (shared > 0) return { kind: 'slide', drop: previous.text.length - shared, text: current.text.slice(shared), metadata };
	return { kind: 'replace', output: current };
}

/**
 * 旧视图后缀与新视图前缀的重叠长度（尾保留窗口滑动时用它换出 `slide`）。
 * 探测法（64 字符探针 + 1 字符兜底、最多 8 个候选）与上游一致：重叠是按字节滑动的窗口，
 * 逐个长度扫是 O(n²)，而这里每次输出变化都要跑一遍。
 */
function suffixPrefixOverlap(before: string, after: string, scan: number): number {
	if (before.length === 0 || after.length === 0 || scan === 0) return 0;
	const tail = before.length > scan ? before.slice(before.length - scan) : before;
	for (const probeLength of [Math.min(64, after.length), 1]) {
		const probe = after.slice(0, probeLength);
		let candidates = 0;
		for (let index = tail.indexOf(probe); index !== -1; index = tail.indexOf(probe, index + 1)) {
			if (++candidates > 8) break;
			const overlapLength = tail.length - index;
			if (overlapLength <= after.length && tail.slice(index) === after.slice(0, overlapLength)) return overlapLength;
		}
		if (probeLength === 1) break;
	}
	return 0;
}

function countNewlines(text: string): number {
	let count = 0;
	for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count++;
	return count;
}
