// 真 IDB 测试的垫片：把 fake-indexeddb 注册成全局 indexedDB / IDBKeyRange。
// vitest 默认 environment 是 node（没有 indexedDB），spec §3 测试 3 的 durability 只能在
// `memory: false` + 真 IndexedDB 上跑——这是 vitest 里唯一可行路径（spec Global Constraints 钉的依赖）。
// 只有显式 `memory: false` 的测试文件 import 它；src/** 永不 import（fake-indexeddb 是 devDependency）。
import 'fake-indexeddb/auto';
