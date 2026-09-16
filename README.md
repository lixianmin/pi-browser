# pi-browser

浏览器等价的 pi coding agent **能力层**（纯库，无 UI、无产品语义）。Spice 是它的第一个消费者，反向依赖它。

设计文档：`spice/docs/superpowers/specs/2026-09-16-pi-browser-s1s3-design.md`。

## 当前状态

M1：S1+S3 基座。浏览器 `ExecutionEnv`（虚拟 FS + mount 路由 + exec 占位 `shell_unavailable`）与会话持久化（`JsonlSessionRepo` 冒烟验证）。S2（工具集 + exec backend）、S4（skills/compaction）、S5（extensions 兼容面）未开始。

## 公开面 API

只有这五个导出（`src/index.ts`）；消费者一律从包入口 import（浏览器产物面禁 deep import）。

| 导出 | 签名 | 用途 |
|---|---|---|
| `createBrowserFileSystem` | `(o?: BrowserFileSystemOptions) => BrowserFileSystem` | fs 工厂：默认 lightning-fs/IDB；`memory: true` 强制内存后端，`memory: false` 强制走 IDB |
| `BrowserFileSystem` | `interface`（pi `FileSystem` + `flush(): Promise<void>`） | 会话持久化契约类型；`flush()` 兑现 lightning-fs 超级块 500ms debounce 之外的落盘 |
| `BrowserFileSystemOptions` | `{ dbName?: string; cwd?: string; fs?: LightningFS; memory?: boolean }` | fs 工厂选项（`dbName` 默认 `'spice-sessions'`） |
| `normalizePath` | `(p: string) => string` | 纯 JS 路径归一（无 `node:path`，浏览器/Node 同构） |
| `createBrowserExecutionEnv` | `(o?: { dbName?: string; mounts?: MountEntry[] }) => ExecutionEnv` | 默认挂载 `/`→IDB、`/tmp`→内存；`exec` 恒 `shell_unavailable`（S2 提供 backend） |

```ts
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { createBrowserExecutionEnv, createBrowserFileSystem } from '@lixianmin/pi-browser';

const env = createBrowserExecutionEnv();                        // '/'→IDB（持久）、'/tmp'→内存（临时）
await env.writeFile('/spice-sessions/s1/main.jsonl', line, BACKGROUND_CONTEXT);
const tmp = await env.createTempDir(undefined, BACKGROUND_CONTEXT);   // 固定落 /tmp 挂载

const fs = createBrowserFileSystem({ dbName: 'spice-sessions' });      // 会话存储用这个（含 flush 契约）
await fs.flush();                                                     // 每回合末调用，否则刷新页面丢会话
```

## 开发

```sh
bun install && bunx vitest run
```
