// src/shell/output-accumulator.ts —— shell 输出的有界累积与展示视图。
//
// 出处：@earendil-works/pi-coding-agent@1.0.0 `dist/core/tools/output-accumulator.js` 的转写
// （它取代了 pi-agent-core@0.99.1 `harness/utils/output-capture.ts` 的增量 diff 模型：
//  `ShellOutputView`/`applyShellOutputUpdate` 已从上游消失，改为「快照」）。
// 上游类注释：流式累积、只为展示保留一段解码尾巴、超阈值时把完整输出落到临时文件。
//
// 平台偏差（spec D1/D2，两处，都是有意的）：
//   D1 `append(data: Uint8Array)`——上游收 Node 全局 `Buffer`（`Buffer` 是 `Uint8Array` 子类，只按字节用，语义无损）。
//   D2 spill 走**注入 seam**——上游直接 `node:crypto`/`node:os`/`node:fs` 开临时文件；浏览器没有 node fs，
//      落盘点是宿主给的挂载表（`/tmp`），因此从构造注入。未接 seam 时超限只截断展示、不落盘、不抛。
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail, utf8ByteLength, type TruncationResult } from '../tools/truncate';
import type { FileSystem } from '../env/types';
// T1.4 会把这一行换成 `from '../env/context'`（chord 单点）；本任务在换源之前，先用现有来源
import { BACKGROUND_CONTEXT } from '../env/context';

export interface OutputAccumulatorOptions {
	/** 展示窗口的行数上限（默认 `DEFAULT_MAX_LINES`） */
	maxLines?: number;
	/** 展示窗口的字节上限（默认 `DEFAULT_MAX_BYTES`） */
	maxBytes?: number;
	/** spill 文件名前缀（默认 `'pi-output'`） */
	tempFilePrefix?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	/** spill 已发生时的**浏览器虚拟路径**（如 `/tmp/pi-output-ab12.log`），不是宿主真实路径（D2） */
	fullOutputPath?: string;
}

export interface FullOutput {
	content: string;
	/** `content` 是否省略了一部分输出 */
	truncated: boolean;
}

/** spill 文件句柄：`append` 同步入队（内部串行），`close` 时 await 全部落地 */
export interface OutputAccumulatorSpillFile {
	readonly path: string;
	append(data: Uint8Array): void;
	close(): Promise<void>;
}

export interface OutputAccumulatorSpill {
	create(prefix: string): OutputAccumulatorSpillFile;
	read(path: string): Promise<Uint8Array>;
}

/**
 * 有界内存地增量跟踪流式输出。
 *
 * `append` 用流式 UTF-8 解码器吃分片，只保留一段解码尾巴供展示快照；一旦跨过阈值就通过注入的
 * spill seam 把完整输出落盘，后续分片直接写盘、不再留在内存里（同上游的有界内存做法）。
 */
export class OutputAccumulator {
	readonly #maxLines: number;
	readonly #maxBytes: number;
	readonly #maxRollingBytes: number;
	readonly #tempFilePrefix: string;
	readonly #spill: OutputAccumulatorSpill | undefined;
	readonly #decoder = new TextDecoder();
	#rawChunks: Uint8Array[] = [];
	#tailText = '';
	#tailBytes = 0;
	#tailStartsAtLineBoundary = true;
	#totalRawBytes = 0;
	#totalDecodedBytes = 0;
	#completedLines = 0;
	#totalLines = 0;
	#currentLineBytes = 0;
	#hasOpenLine = false;
	#finished = false;
	#spillFile: OutputAccumulatorSpillFile | undefined;
	#spillPath: string | undefined;

	constructor(options: OutputAccumulatorOptions = {}, spill?: OutputAccumulatorSpill) {
		this.#maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		// 滚动窗口留 2 倍上限的余量：每次裁窗口是 O(窗口)，贴着上限裁会让大输出退化成 O(n²)
		this.#maxRollingBytes = Math.max(this.#maxBytes * 2, 1);
		this.#tempFilePrefix = options.tempFilePrefix ?? 'pi-output';
		this.#spill = spill;
	}

	/** 喂一段原始输出（stdout/stderr **合并**；上游 Node 实现同样把两路喂进一个视图） */
	append(data: Uint8Array): void {
		if (this.#finished) throw new Error('Cannot append to a finished output accumulator');
		this.#totalRawBytes += data.length;
		this.#appendDecodedText(this.#decoder.decode(data, { stream: true }));
		if (this.#spillFile || this.#shouldUseSpill()) {
			this.#ensureSpillFile();
			this.#spillFile?.append(data);
		} else if (data.length > 0) {
			this.#rawChunks.push(data);
		}
	}

	/** 收尾：刷掉解码器里未成形的尾部字节；超阈值时建 spill 文件 */
	finish(): void {
		if (this.#finished) return;
		this.#finished = true;
		this.#appendDecodedText(this.#decoder.decode());
		if (this.#shouldUseSpill()) this.#ensureSpillFile();
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.#getSnapshotText(), { maxLines: this.#maxLines, maxBytes: this.#maxBytes });
		const truncated = this.#totalLines > this.#maxLines || this.#totalDecodedBytes > this.#maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.#totalDecodedBytes > this.#maxBytes ? 'bytes' : 'lines'))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.#totalLines,
			totalBytes: this.#totalDecodedBytes,
			maxLines: this.#maxLines,
			maxBytes: this.#maxBytes,
		};
		if (options.persistIfTruncated && truncation.truncated) this.#ensureSpillFile();
		return { content: truncation.content, truncation, fullOutputPath: this.#spillPath };
	}

	/** 关掉 spill 文件（写队列落地）。路径保留，之后再 `readFullOutput` 仍可读 */
	async closeTempFile(): Promise<void> {
		const file = this.#spillFile;
		if (!file) return;
		this.#spillFile = undefined;
		await file.close();
	}

	/**
	 * 完整输出给能吃下不止展示快照的调用方。应在 `finish()` 与 `closeTempFile()` 之后调。
	 * 长于 `maxBytes` 原始字节时保留首尾各 `maxBytes / 2` 字节，中间换成省略标记（上游同形）。
	 */
	async readFullOutput(maxBytes: number): Promise<FullOutput> {
		if (!this.#spillPath || !this.#spill) {
			return { content: new TextDecoder().decode(concatChunks(this.#rawChunks)), truncated: false };
		}
		const bytes = await this.#spill.read(this.#spillPath);
		if (bytes.length <= maxBytes) {
			return { content: new TextDecoder().decode(bytes), truncated: false };
		}
		const headBytes = Math.floor(maxBytes / 2);
		const tailBytes = maxBytes - headBytes;
		const head = bytes.subarray(0, headBytes);
		const tail = bytes.subarray(bytes.length - tailBytes);
		// 只在字符边界切：流式解码会自己扣住不完整的尾部序列，尾部则跳过续接字节
		const headText = new TextDecoder().decode(head, { stream: true });
		let tailStart = 0;
		while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
		const tailText = new TextDecoder().decode(tail.subarray(tailStart));
		const omitted = bytes.length - headBytes - tailBytes;
		return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
	}

	getLastLineBytes(): number {
		return this.#currentLineBytes;
	}

	#appendDecodedText(text: string): void {
		if (text.length === 0) return;
		const bytes = utf8ByteLength(text);
		this.#totalDecodedBytes += bytes;
		this.#tailText += text;
		this.#tailBytes += bytes;
		if (this.#tailBytes > this.#maxRollingBytes * 2) this.#trimTail();

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.#currentLineBytes += bytes;
			this.#hasOpenLine = true;
		} else {
			this.#completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.#currentLineBytes = utf8ByteLength(tail);
			this.#hasOpenLine = tail.length > 0;
		}
		this.#totalLines = this.#completedLines + (this.#hasOpenLine ? 1 : 0);
	}

	#trimTail(): void {
		const buffer = new TextEncoder().encode(this.#tailText);
		if (buffer.length <= this.#maxRollingBytes) {
			this.#tailBytes = buffer.length;
			return;
		}
		let start = buffer.length - this.#maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
		this.#tailStartsAtLineBoundary = start === 0 ? this.#tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.#tailText = new TextDecoder().decode(buffer.subarray(start));
		this.#tailBytes = utf8ByteLength(this.#tailText);
	}

	#getSnapshotText(): string {
		if (this.#tailStartsAtLineBoundary) return this.#tailText;
		const firstNewline = this.#tailText.indexOf('\n');
		return firstNewline === -1 ? this.#tailText : this.#tailText.slice(firstNewline + 1);
	}

	#shouldUseSpill(): boolean {
		return this.#totalRawBytes > this.#maxBytes || this.#totalDecodedBytes > this.#maxBytes || this.#totalLines > this.#maxLines;
	}

	#ensureSpillFile(): void {
		if (this.#spillPath) return;
		if (!this.#spill) return;   // D2：没接落盘 seam 时不落盘（超限仍截断展示）
		const file = this.#spill.create(this.#tempFilePrefix);
		this.#spillFile = file;
		this.#spillPath = file.path;
		for (const chunk of this.#rawChunks) file.append(chunk);
		this.#rawChunks = [];
	}
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const c of chunks) total += c.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

/**
 * 用挂载表实现 spill seam（D2）：落在挂载表的临时文件面（默认 `/tmp`，即内存挂载）。
 * 返回的路径是**虚拟路径**——只有同一个 env 读得到（spec Review Focus #1 有测试钉住）。
 */
export function createMountSpill(table: FileSystem, prefix = 'pi-output'): OutputAccumulatorSpill {
	let counter = 0;
	return {
		create(tempFilePrefix: string): OutputAccumulatorSpillFile {
			const path = `/tmp/${tempFilePrefix || prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}.log`;
			let queue: Promise<void> = Promise.resolve();
			let failure: Error | undefined;
			let opened = false;
			return {
				path,
				append(data: Uint8Array): void {
					const copy = data.slice();   // 调用方可能复用同一缓冲区，先拷
					queue = queue.then(async () => {
						const result = opened
							? await table.appendFile(path, copy, BACKGROUND_CONTEXT)
							: await table.writeFile(path, copy, BACKGROUND_CONTEXT);
						opened = true;
						if (!result.ok) throw new Error(`spill 落盘失败（${result.error.code}）：${path}`);
					}).catch((e: unknown) => {
						failure ??= e instanceof Error ? e : new Error(String(e));
						// 吞掉以免后续 append 的 promise 链断掉；错误在 close() 处响亮抛出
					});
				},
				async close(): Promise<void> {
					await queue;
					if (failure) throw failure;
				},
			};
		},
		async read(path: string): Promise<Uint8Array> {
			const result = await table.readBinaryFile(path, BACKGROUND_CONTEXT);
			if (!result.ok) throw new Error(`spill 文件读不回（${result.error.code}）：${path}`);
			return result.value;
		},
	};
}
