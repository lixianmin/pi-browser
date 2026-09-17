// src/extensions/define.ts —— S5 spec §3.1：扩展声明的「校验 + 归一」入口。
//
// 扩展是**宿主自己的对象**（浏览器原生对象，不经 jiti、不做 fs 发现，见 README「扩展」节），因此这里只做
// 声明期能查清的事：缺 `description` 模型就选不准工具、缺 `parameters` 上游没法校验入参、缺 `execute`
// 工具就是空的——四类一律响亮抛错，不静默填空（静默失效比报错更糟，同 S2.1 宿主命令名的口径）。
import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';

/** 扩展工具声明：与内置工具（`src/tools/*`）同形，只是 `label` 可省。 */
export interface ExtensionToolSpec {
	/** 工具名（模型可见）；同一扩展内不得重复 */
	name: string;
	/** UI 展示名；省略时 `defineExtension` 归一为 `name`（上游 `AgentTool.label` 非空） */
	label?: string;
	description: string;
	/** typebox schema；只查存在，入参校验由上游做 */
	parameters: TSchema;
	/**
	 * 与 `AgentTool.execute` 同签名。`params` 用 `any` 而不是 `Static<TSchema>`：后者会退化成 `unknown`，
	 * 于是 `createReadTool(...)` 这类具体 schema 的工具（`AgentTool<typeof schema>`）就赋不进来。
	 */
	execute: (
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<any>,
	) => Promise<AgentToolResult<any>>;
}

/** 一个扩展的声明。S5 只有工具这一个子集（其余 pi 扩展面见 README 的「不支持」清单）。 */
export interface ExtensionSpec {
	/** 扩展名：进报错溯源（`providerOf`），也用于定位「哪个扩展的工具重名了」 */
	name: string;
	tools?: ExtensionToolSpec[];
}

/** 校验并归一一个扩展声明；任一校验不过就抛错（错误信息带扩展名/工具名，便于定位） */
export function defineExtension(spec: ExtensionSpec): ExtensionSpec {
	if (typeof spec.name !== 'string' || spec.name.trim() === '') {
		throw new Error('defineExtension：`name` 不能为空（扩展名要进 providerOf 与报错溯源）');
	}
	const seen = new Set<string>();
	const tools = (spec.tools ?? []).map((tool): ExtensionToolSpec => {
		if (typeof tool.name !== 'string' || tool.name.trim() === '') {
			throw new Error(`defineExtension("${spec.name}")：工具缺少 name`);
		}
		if (seen.has(tool.name)) {
			throw new Error(`defineExtension("${spec.name}")：同一扩展内工具重名 "${tool.name}"`);
		}
		seen.add(tool.name);
		if (typeof tool.description !== 'string' || tool.description.trim() === '') {
			throw new Error(`defineExtension("${spec.name}")：工具 "${tool.name}" 缺少 description（模型靠它选工具）`);
		}
		if (tool.parameters === undefined || tool.parameters === null) {
			throw new Error(`defineExtension("${spec.name}")：工具 "${tool.name}" 缺少 parameters（typebox schema）`);
		}
		if (typeof tool.execute !== 'function') {
			throw new Error(`defineExtension("${spec.name}")：工具 "${tool.name}" 缺少 execute 函数`);
		}
		return { ...tool, label: tool.label ?? tool.name };
	});
	return { name: spec.name, tools };
}
