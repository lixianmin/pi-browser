# PI Browser Debugger 扩展(DevTools 面板)设计

日期:2026-09-21
状态:已批准(设计对话 + 用户确认 go)

## 1. 目标与非目标

**目标(v1 = M1)**:仓库内新增子项目 `debugger/`,构建产物是一个**不发布**的 Chrome MV3 扩展,在 DevTools 里注册 "PI Browser" 面板,对当前被检查页面 origin 的 LightningFS/IDB 目录结构做文件浏览器级调试:列目录、浏览树、查看文本、编辑保存、删除、新建文件/目录、重命名、切换 IDB 库。

**非目标(v1 不做)**:raw IDB 键值视图、内容搜索、导出 diff、bash/终端面板、发布商店。这些是后续 Debugger 演进项(见 §9)。

## 2. 已验证的技术事实(设计依据)

| # | 事实 | 来源 |
|---|---|---|
| F1 | `chrome.scripting.executeScript` 注入的函数若返回 Promise,**Chrome 会等待 settle 后把值作为 `InjectionResult.result` 返回** | 官方 scripting 文档 "Handle the results > Promises" |
| F2 | `ScriptInjection.world`(`'MAIN'`)Chrome 95+;`func`/`args` Chrome 92+;`args` 必须可 JSON 序列化;`func` 经序列化注入,**闭包与模块导入全部丢失** | 同上 Types 节 |
| F3 | LightningFS 布局:IDB database = `dbName`,单个 object store = `<dbName>_files`;键 `"!root"` → 超级块,inode id → 文件字节;跨实例并发靠 Web Locks(`Mutex2`,锁库 `<dbName>_lock`) | lightning-fs 源码 `IdbBackend.js`/`DefaultBackend.js` |
| F4 | 主包 `createBrowserFileSystem({ dbName, memory: false })` → `new LightningFS(dbName)`,与宿主同库同 store,且提供 `flush()` 兑现超级块 500ms debounce 的落盘 | `src/env/backend-idb.ts`、`src/env/types.ts` |
| F5 | pi `FileSystem` 契约操作面足够:`listDir / readTextFile / readBinaryFile / writeFile / renameFile / fileInfo / createDir / remove(recursive) / exists`,每操作带 `Context` 参数 | `@earendil-works/pi-agent-core` `harness/types.d.ts` |
| F6 | lightning-fs 可在 node + fake-indexeddb 下完整跑通(主仓库 `idb-backend.test.ts` 等先例) | 本仓库测试 |

## 3. 架构

```
┌─ DevTools 面板(panel.html, 扩展 origin, React) ─────────────┐
│  文件树 / 预览编辑 / 库选择                                    │
│  transport.ts: op → chrome.runtime.sendMessage → 结果         │
└──────────────┬───────────────────────────────────────────────┘
               │ chrome.runtime 消息(官方背书的 devtools↔background 模式)
┌──────────────▼───────────────────────────────────────────────┐
│  background service worker(执行点)                            │
│  chrome.scripting.executeScript({                             │
│    target: {tabId: <inspected>},                              │
│    world: 'MAIN',                                             │
│    files: ['bridge.js']   // 首次/导航后:装载常驻 bridge        │
│    // 或 func: op => window.__piBrowserDebugger.handle(op)    │
│  })                                                           │
└──────────────┬───────────────────────────────────────────────┘
               │ 注入到被检查页面 main world
┌──────────────▼───────────────────────────────────────────────┐
│  bridge.js(常驻,幂等安装,带 __PI_BRIDGE_VERSION__)            │
│  createBrowserFileSystem({dbName, memory:false})  // F4       │
│  handle(op): list/read/write/delete/mkdir/rename/stat/dbs     │
│  结果 JSON 化(二进制 → base64),错误 → {code,message}           │
└──────────────────────────────────────────────────────────────┘
```

**为何 background 执行注入**:DevTools 上下文可用的扩展 API 是白名单制,是否直通 `chrome.scripting` 不赌记忆;panel → `chrome.runtime.sendMessage` → background → `executeScript` 是官方文档背书的标准模式,无论白名单内容如何都成立。background 顺带成为未来其他入口(side panel 等)共用的执行点。

**为何常驻 bridge 而不是每次注入函数**:F2 的序列化约束下,函数注入无法 import LightningFS,只能裸复刻超级块格式与互斥协议(F3),上游升级即碎。常驻 bundle 复用真实 LightningFS,互斥/flush 全是上游行为,零协议重复。

**导航重装**:面板监听 `chrome.devtools.network.onNavigated`,通知 background 重新装载 bridge(幂等)。

**权限清单**:`permissions: ["scripting"]` + `host_permissions: ["<all_urls>"]`(用户已选宽权限;私有调试工具,Load unpacked 使用,不上架)。`minimum_chrome_version: "95"`(F2 中 `world` 下限)。

## 4. 子项目与发布隔离

- `debugger/` 为 bun workspace 成员,包名 `@lixianmin/pi-browser-debugger`,`private: true`,`@lixianmin/pi-browser: "workspace:*"` 直连主包源码;遵守「浏览器产物面禁 deep import」。
- 根 `package.json`:
  - `"workspaces": ["debugger"]`
  - `"files": ["src", "test", "README.md"]` —— 发布白名单。**注意**:当前无 `files` 字段,`npm pack` 会把 `tsconfig.json`/`AGENTS.md`/`bun.lock` 一并发出;加白名单后发布内容收敛为 src+test+README,视为修正。验收:`npm pack --dry-run` 无 `debugger/` 文件。
- 根 `vitest.config.ts` 加 `include: ['test/**/*.test.ts']`,防根 `bun test` 误扫 debugger 测试(它们需要 jsdom,根环境是 node);根包覆盖率阈值与 `src/**` 白名单不动。

## 5. 构建与开发循环

- Vite + `@vitejs/plugin-react`;入口:`panel.html`(React 面板)、`devtools.html`+`devtools.ts`(`chrome.devtools.panels.create('PI Browser', …, 'panel.html')`)、`background.ts`、`bridge.js`(iife)。
- `manifest.json` 构建时原样拷入 `dist/`(自写 ~10 行 copy 插件)。不用 @crxjs(v2 长期 beta,维护风险)。
- 产物 `debugger/dist/` = Load unpacked 目录,进 `.gitignore`。
- 开发循环:`vite build --watch` + chrome://extensions 手动 reload;`debugger/testbed/` 提供本地静态页(创建 LightningFS 样例数据),作被调试对象。
- TypeScript strict;根 `tsc --noEmit` 不覆盖子项目,debugger 自带 typecheck 脚本。

## 6. 协议与 UI

**Ops**(共享类型,面板/bridge 同源):`databases` / `list(path)` / `read(path, {maxBytes})` / `write(path, data, {encoding})` / `delete(path, {recursive})` / `mkdir(path)` / `rename(from, to)` / `stat(path)`。结果一律 JSON 可序列化:文本为 string、二进制为 base64 + 标志位;错误 `{code, message}`(沿 FileError code 语义)。

**UI(React, 普通 CSS, 无 UI 库)**:
- 顶栏:IDB 库下拉(bridge 调 `indexedDB.databases()`,默认 `spice-sessions`)、刷新、面包屑。
- 左:懒加载目录树。
- 右:文本预览(超 200KB 截断提示)→ 编辑 → 保存/删除(确认)/新建文件/新建目录/重命名;二进制文件显示大小 + base64 只读占位。
- 状态栏:操作结果与错误提示;「宿主页面可能需刷新才见外部写入」的固定提示。

**语义要点**:
- 每次写操作后调 `flush()`(F4 契约),再返回结果。
- 调试器读 IDB 落盘态;宿主有内存缓存 + debounce flush,双向可见性存在时间差——UI 如实提示,不做跨实例缓存同步(v1 明确接受)。

## 7. 测试策略

- **bridge 核心 + 协议**(vitest + fake-indexeddb + `memory: false`,F6):op 分发语义、JSON 可序列化往返、错误映射、幂等安装、flush 后可见性。TDD 先红后绿。
- **background/传输层**:mock `chrome.runtime`/`chrome.scripting`/`chrome.devtools`,测消息路由、tabId 透传、导航重装触发。
- **UI 组件**:v1 不强制组件测试;手动验收清单(spec §8)写死。根包覆盖率阈值不受影响。

## 8. 手动验收清单(每次发布 dist 前过一遍)

1. `bun run build`(debugger)产出 `dist/`;chrome://extensions 加载 unpacked。
2. 打开 `debugger/testbed/` 页面(造好样例 fs),对该页开 DevTools → "PI Browser" 面板。
3. 列目录/进目录/返回;打开文本文件预览;编辑保存 → testbed 页重读确认生效;新建文件/目录;重命名;删除(含目录递归)。
4. 切换到另一个 IDB 库再切回。
5. 页面刷新后面板恢复可用(bridge 重装)。

## 9. 演进方向(v1 之后,不在本 spec 范围)

raw IDB 键值视图(调试 lightning-fs 本身,单 store 键值对结构简单)、全库搜索、导出/diff;长期复用主包 `createBrowserExecutionEnv` 在 bridge 侧挂 busybox,长成 bash 面板——DevTools 形态的最终形态是本仓库的配套 Debugger。

## 10. 已知限制(如实声明)

- 面板只在 DevTools 打开时可用(形态固有)。
- 双实例(宿主/调试器)经 Web Locks 串行化,但可见性有时间差(见 §6);调试器不做宿主缓存失效。
- 大文件/二进制 v1 只读;文本预览截断 200KB。
- `indexedDB.databases()` 是 Chrome 71+ 非标准 API(本项目目标浏览器即 Chrome,可接受)。
