import { type Context } from '../env/context.js';
import { type FileInfo } from '@earendil-works/pi-durable/env';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { BrowserFileSystem } from '../env/types.js';
/** 工具结果包装：pi 的 content 是块数组，details 是给 UI/日志的结构化信息（缺省 {}） */
export declare function textResult<TDetails extends object>(text: string, details?: TDetails): AgentToolResult<TDetails>;
/** 工具的 context：带 signal 时派生出可取消 context（exec 的 abort 路径靠 context.abortSignal 传导） */
export declare function contextFor(signal?: AbortSignal): Context;
/** 工具调用前的 abort 检查（fs 后端不感知 signal，只能由工具自查；与 spice 同语义） */
export declare function throwIfAborted(signal?: AbortSignal): void;
export declare function readText(fs: BrowserFileSystem, absolutePath: string, context: Context): Promise<string>;
export declare function writeText(fs: BrowserFileSystem, absolutePath: string, content: string, context: Context): Promise<void>;
export declare function statPath(fs: BrowserFileSystem, absolutePath: string, context: Context): Promise<FileInfo>;
/** 目录直属子项，按名排序（localeCompare 随 locale 漂 → 用码点比较，输出可复现） */
export declare function listChildren(fs: BrowserFileSystem, absoluteDir: string, context: Context): Promise<FileInfo[]>;
/** 深度优先遍历（目录先于其子项），递归用显式栈遍历同一份 listChildren 排序结果 */
export declare function listTree(fs: BrowserFileSystem, rootDir: string, context: Context): Promise<FileInfo[]>;
/** 工具输出里给模型的路径：cwd 之下用相对路径（`src/a.ts`），之外保持绝对 */
export declare function displayPath(absolutePath: string, cwd: string): string;
