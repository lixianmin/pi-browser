# PI Browser Debugger 扩展实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 仓库内 `debugger/` 子项目构建出永不发布的 Chrome MV3 DevTools 扩展,面板内浏览/编辑/删除被检查页面 LightningFS/IDB 内容。

**Architecture:** panel(React)→ `chrome.runtime` 消息 → background SW → `chrome.scripting.executeScript(world:'MAIN')` 注入常驻 bridge(复用 `createBrowserFileSystem`,同库同 store + Web Locks 互斥)→ JSON 化结果原路返回。

**Tech Stack:** Vite + React 18 + TypeScript strict + vitest + fake-indexeddb;主包 `@lixianmin/pi-browser`(workspace:* 直连源码)。

**Spec:** `docs/superpowers/specs/2026-09-21-pi-browser-debugger-extension-design.md`

## Global Constraints

- MV3;`minimum_chrome_version: "95"`(`ScriptInjection.world` 下限,F2);`permissions: ["scripting"]`;`host_permissions: ["<all_urls>"]`。
- bridge 侧一切 op 结果 JSON 可序列化(二进制 base64);写操作后必须 `flush()`(spec §6)。
- 根包发布白名单 `files: ["src", "test", "README.md"]`;`npm pack --dry-run` 不得出现 `debugger/`。
- 根 vitest `include: ['test/**/*.test.ts']`;根覆盖率阈值不动。
- 遵守主包规矩:消费者从包入口 import,浏览器产物面禁 deep import(testbed 例外,同仓库内工具页可相对 import)。
- 只 commit 不 push(AGENTS.md §11)。

## Review Focus

- **同库双实例可见性**:调试器写后宿主不可见(宿主有内存缓存)——UI 必须提示;测试钉「写后 flush,重开实例可读」。
- **JSON 边界**:executeScript args 与返回值两次 JSON 往返,Uint8Array/undefined 会丢——协议测试钉 JSON 往返不变性。
- **bridge 幂等/版本**:页面已有旧版本 bridge 时必须替换而非叠加——install 测试钉。
- **executeScript 异常路径**(tab 关闭/无 host):background 必须回 `{ok:false,error}` 而非悬死——background 测试钉。
- **大文件**:read 超 200KB 截断且 `truncated:true`,不炸 JSON 通道——handler 测试钉。

---

### Task 1: 发布隔离与子项目骨架

**Files:** Modify `package.json`(根)、`vitest.config.ts`;Create `debugger/package.json`、`debugger/tsconfig.json`

**Interfaces(Produces):** workspace `@lixianmin/pi-browser-debugger`;根测试范围收窄。

- [ ] 根 `package.json` 加 `"workspaces": ["debugger"]`、`"files": ["src", "test", "README.md"]`
- [ ] 根 `vitest.config.ts` 加 `include: ['test/**/*.test.ts']`
- [ ] `debugger/package.json`:`private: true`,deps `@lixianmin/pi-browser: workspace:*`、`@earendil-works/pi-agent-core`、react/react-dom;devDeps 用 `bun add -d` 落真实版本(vite、@vitejs/plugin-react、vitest、fake-indexeddb、jsdom、@types/chrome、@types/react、@types/react-dom、typescript 对齐根 ^7.0.2)
- [ ] `debugger/tsconfig.json`:对齐根(strict、bundler、react-jsx、types chrome+vite/client)
- [ ] 验证:`bun install`;根 `bun test` 全绿;根 `npm pack --dry-run` 无 debugger;commit

### Task 2: 协议模块(TDD)

**Files:** Create `debugger/src/shared/protocol.ts`;Test `debugger/test/protocol.test.ts`

**Produces:** `FsOp`、`OpResult`、`ListEntry`、`DEFAULT_DB='spice-sessions'`、`DEFAULT_MAX_BYTES=200*1024`、`bytesToBase64/base64ToBytes`(分块 btoa/atob)

- [ ] 失败测试:JSON 往返不变(JSON.parse(JSON.stringify(result)) 深等);base64 对含 0x00/多字节 UTF-8 往返;FsOp 各 variant 可 JSON 往返
- [ ] 跑红 → 实现 → 跑绿 → commit

### Task 3: bridge handler(TDD)

**Files:** Create `debugger/src/bridge/handler.ts`;Test `debugger/test/handler.test.ts`

**Consumes:** Task 2 协议;`createBrowserFileSystem({dbName, memory:false})`、`BACKGROUND_CONTEXT`。
**Produces:** `handleOp(dbName: string, op: FsOp): Promise<OpResult>`;`resetHandlerCache()`(测试隔离用,清 open-fs 表)。

- [ ] 失败测试(`fake-indexeddb/auto` + 各测试用独立 dbName):
  - write→list 层级(目录带 kind:'directory');write→read 文本 roundtrip
  - read 二进制(写入含 0x00 的 bytes,经 write base64)→ `encoding:'base64'`
  - read 超 maxBytes → `truncated:true` 且 content 截断
  - mkdir→write 子文件→delete(recursive)→stat 报 not_found
  - rename 改路径后旧路径 not_found
  - 未命中 → `{ok:false,error:{code:'not_found'}}`(FileError 映射)
  - databases:两个库各写一个文件 → names 含两者且排序
  - flush 契约:write 后同进程新开 `createBrowserFileSystem` 实例可读到(超级块落盘)
  - 所有 OpResult JSON 往返不变
- [ ] 跑红 → 实现(dispatch switch + Result 解包 + FileError→OpError 映射 + 写后 flush)→ 跑绿 → commit

### Task 4: bridge 安装(TDD,jsdom)

**Files:** Create `debugger/src/bridge/install.ts`、`src/bridge/entry.ts`(iife 入口,仅 `installBridge()`);Test `debugger/test/install.test.ts`(`// @vitest-environment jsdom`)

**Produces:** `PI_BRIDGE_VERSION=1`;`installBridge(): 'installed'|'replaced'|'current'`;`window.__piBrowserDebugger = { version, call(dbName, op) }`

- [ ] 失败测试:首装 'installed' 且经 `window.__piBrowserDebugger.call` write/read 走通(接 Task 3 handler);同版本再装 'current'(实例引用不变);伪造旧版本对象再装 'replaced'
- [ ] 跑红 → 实现 → 跑绿 → commit

### Task 5: background 执行点(TDD)

**Files:** Create `debugger/src/background/inject.ts`、`src/background/router.ts`、`src/background/background.ts`(chrome 接线,薄);Test `debugger/test/background.test.ts`

**Produces:**
- `ensureBridge(scripting, tabId, expected?)`:先 func 注入读 `window.__piBrowserDebugger?.version`,非期望版本再 `files:['bridge.js']` 注入(world 均 MAIN)
- `callBridge(scripting, tabId, dbName, op)`:func+args 注入调 `__piBrowserDebugger.call`,返回 `OpResult`
- `createMessageHandler({ensureBridge, callBridge})` → `chrome.runtime.onMessage` listener:只处理 `type:'pi-debugger-call'`,async `sendResponse`,任何异常回 `{ok:false,error:{code:'bridge_unreachable'}}`,返回 `true` 保持通道

- [ ] 失败测试(mock scripting 记录调用):版本命中跳过 files 注入/未命中触发;callBridge 传参与取 result;handler 路由 op→callBridge 结果;executeScript reject → bridge_unreachable;非本扩展消息返回 false
- [ ] 跑红 → 实现 → 跑绿 → commit

### Task 6: panel UI + devtools 入口 + testbed + 构建

**Files:** Create `debugger/manifest.json`、`vite.config.ts`、`vite.bridge.config.ts`、`src/devtools/devtools.{ts,html}`、`src/panel/{panel.html,main.tsx,App.tsx,Tree.tsx,FileView.tsx,panel.css,transport.ts}`、`testbed/{index.html,main.ts}`;Test `debugger/test/transport.test.ts`(mock chrome.runtime.sendMessage)

**Produces:**
- `transport.callOp(tabId, dbName, op): Promise<OpResult>`(sendMessage `{type:'pi-debugger-call', tabId, dbName, op}`)+ `ensure(tabId)` 消息复用同路由
- manifest(见 Global Constraints;`background:{service_worker:'background.js',type:'module'}`;`devtools_page:'devtools.html'`)
- vite app 配置:inputs `panel.html`、`devtools.html`、`testbed/index.html`、`src/background/background.ts`(es,`entryFileNames` 把 background 钉为 `background.js`),`copyManifest` 插件拷 `manifest.json` 进 dist;bridge 配置:lib 单入口 iife → `dist/bridge.js`(`emptyOutDir:false`)
- panel 行为(spec §6):库下拉(默认 spice-sessions)、面包屑、懒加载树、文本预览(截断提示)/base64 占位、编辑保存、删除确认、新建文件/目录、重命名、状态栏含「宿主可能需刷新」提示、`chrome.devtools.network.onNavigated` → ensure 重装
- testbed:按钮 seed 两个库(`spice-sessions` 样例树 + `spice-alt` 单文件),`createBrowserFileSystem` + `flush()`

- [ ] transport 失败测试 → 实现 → 绿
- [ ] 全部 UI/devtools/testbed/构建配置落盘;`bun run build` → dist 必含 `manifest.json`、`devtools.html`、`panel.html`、`background.js`、`bridge.js`、`testbed/`
- [ ] `bun run typecheck`、`bun test` 绿;commit

### Task 7: 终验

- [ ] 根:`bun test`、`bun run typecheck` 绿
- [ ] 根:`npm pack --dry-run` 内容仅 src/test/README 系,无 debugger
- [ ] `debugger/dist` 清单核对;spec §8 手动验收清单写进最终汇报(用户在 Chrome 里执行)

## 计划外说明

- UI 组件不写自动化测试(spec §7 已裁决);dist 产物名(background.js/bridge.js/manifest.json)是扩展加载契约,构建验证步骤钉住。
- 版本号以 `bun add` 实际落盘为准,计划不猜版本。
