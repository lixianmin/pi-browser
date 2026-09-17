// src/extensions/compose.ts —— S5 spec §3.1：把「宿主内置工具」与「扩展提供的工具」合成一份工具集。
//
// 重名默认**抛错**（既不静默让扩展顶掉内置，也不静默让扩展被丢掉——静默失效比报错更糟）；
// `overrideBuiltins` 是唯一的口子，且必须由宿主显式列出名字（默认空 = 安全边界）。冲突信息带双方来源
// （`providerOf` 的同源标签），宿主一眼能看出「谁撞了谁」。
// 顺序稳定：内置占前段（被覆盖的扩展工具顶在原槽位），扩展按声明序追加。
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { ExtensionSpec, ExtensionToolSpec } from './define';

/** 内置工具的来源标签（`providerOf` 的值；扩展来源就是扩展名） */
export const BUILTIN_PROVIDER = 'builtin';

export interface ComposeToolsetOptions {
	/** 宿主内置工具（`src/tools/*` 的产物） */
	builtin?: ExtensionToolSpec[];
	/** 扩展（`defineExtension` 的产物，或同形的原生对象） */
	extensions?: ExtensionSpec[];
	/** 允许被扩展覆盖的内置工具名；不在表里的内置重名一律抛错 */
	overrideBuiltins?: string[];
}

export interface ComposedToolset {
	/** 可直接赋给 `AgentContext['tools']`（上游 `AgentTool[]`）：内置 + 扩展；要进 `AgentHarness` 需再过 `toHarnessTool` */
	tools: AgentTool[];
	/** 工具名 → 来源（`builtin` 或扩展名），报错溯源与宿主排障用 */
	providerOf: Record<string, string>;
}

/** 合成工具集：`builtin` 在前，`extensions` 按声明序追加；重名按 `overrideBuiltins` 裁决 */
export function composeToolset(options: ComposeToolsetOptions = {}): ComposedToolset {
	const overrides = new Set(options.overrideBuiltins ?? []);
	// Map 的插入序就是产物顺序；对已存在的键 `set` 不改槽位（覆盖内置时扩展工具顶在原位）
	const entries = new Map<string, { tool: AgentTool; provider: string }>();

	const add = (spec: ExtensionToolSpec, provider: string): void => {
		const conflict = entries.get(spec.name);
		if (conflict !== undefined) {
			const fromBuiltin = conflict.provider === BUILTIN_PROVIDER && provider !== BUILTIN_PROVIDER;
			if (!(fromBuiltin && overrides.has(spec.name))) {
				const sources = conflict.provider === provider ? `${provider} 提供了两次` : `${conflict.provider} 与 ${provider} 都提供`;
				const hint = fromBuiltin ? '；要覆盖内置需把名字显式列进 overrideBuiltins' : '';
				throw new Error(`工具重名："${spec.name}"：${sources}${hint}`);
			}
		}
		entries.set(spec.name, { tool: { ...spec, label: spec.label ?? spec.name }, provider });
	};

	for (const spec of options.builtin ?? []) add(spec, BUILTIN_PROVIDER);
	for (const extension of options.extensions ?? []) {
		for (const spec of extension.tools ?? []) add(spec, extension.name);
	}

	const providerOf: Record<string, string> = {};
	for (const [name, entry] of entries) providerOf[name] = entry.provider;
	return { tools: [...entries.values()].map((entry) => entry.tool), providerOf };
}
