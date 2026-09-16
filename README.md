# pi-browser

浏览器等价的 pi coding agent **能力层**（纯库，无 UI、无产品语义）。Spice 是它的第一个消费者，反向依赖它。

设计文档：`spice/docs/superpowers/specs/2026-09-16-pi-browser-s1s3-design.md`。

## 当前状态

M1：S1+S3 基座。浏览器 `ExecutionEnv`（虚拟 FS + mount 路由 + exec 占位 `shell_unavailable`）与会话持久化（`JsonlSessionRepo` 冒烟验证）。S2（工具集 + exec backend）、S4（skills/compaction）、S5（extensions 兼容面）未开始。

## 开发

```sh
bun install && bunx vitest run
```
