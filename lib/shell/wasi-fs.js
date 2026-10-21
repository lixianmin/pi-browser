// src/shell/wasi-fs.ts —— wasi-sh `FileSystem` 的同步适配器（spec §3.1）。
//
// 为什么需要：wasi-sh 的注入面是 12 个**同步**方法、失败抛 Linux errno（`node_modules/wasi-sh/src/fs.d.mts`
// 是权威 API）——guest 是调用之下的同步 wasm 栈帧，没有可 await 的地方。pi-browser 的权威态却是异步
// Result 契约的 BrowserFileSystem。于是：一份同步内存缓存当 run 期间的真相源，跨边界的同步只发生在
// run 边界（seed / exportChanges，见 sync-session.ts）。
//
// 明确不做：不在这里碰 IDB（单写者协议规定 IDB 只由主线程在 run 边界写）；不做 shell 之外的持久化。
import { BACKGROUND_CONTEXT } from '../env/context.js';
import { DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, S_IFDIR, S_IFMT, S_IFREG, fsError, } from 'wasi-sh/fs';
import { createMountTable } from '../env/mount.js';
import { normalizePath } from '../env/path.js';
/**
 * worker（`src/shell/worker.ts`）与主线程（exec 的 worker 路径）之间的拉取协议。
 * 常量住这里而不是 worker.ts：worker 模块 import 时会执行 `serve()`，主线程不能 import 它。
 */
export const PULL_CHANGES = 'pi-browser:pull-changes';
/**
 * 主线程 → worker：把宿主的目录列表（含**空目录**）在 spawn 前交给 guest。
 * spawn 的 `files` 只表达文件，wasi-sh 只建文件的父目录；不补这条消息，空目录在 guest 里从不存在，
 * 收尾对账会把它算成「已删除」并从宿主递归删掉（静默数据丢失）。
 */
export const PUSH_DIRS = 'pi-browser:push-dirs';
const parentOf = (path) => {
    const i = path.lastIndexOf('/');
    return i > 0 ? path.slice(0, i) : '/';
};
const baseOf = (path) => path.slice(path.lastIndexOf('/') + 1);
const depthFirst = (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b);
export const bytesEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
/**
 * 把挂载树读成变更集形状（`deleted` 恒空）。两个真实调用方：适配器的 `seed()`，以及 exec 的
 * worker 路径（整树经 spawn 的 `files` 推给 worker——活着的 guest 钳住线程，postMessage 进不去）。
 */
export async function readMountTree(store) {
    const table = createMountTable(store.mounts);
    const ctx = BACKGROUND_CONTEXT;
    const dirs = [];
    const written = [];
    const walk = async (path) => {
        const listed = await table.listDir(path, ctx);
        if (!listed.ok)
            throw new Error(`读取挂载树失败: ${listed.error.code} ${listed.error.message}`);
        for (const entry of listed.value) {
            if (entry.kind === 'directory') {
                dirs.push(entry.path);
                await walk(entry.path);
                continue;
            }
            const bytes = await table.readBinaryFile(entry.path, ctx);
            if (!bytes.ok)
                throw new Error(`读取文件失败: ${bytes.error.code} ${bytes.error.message}`);
            written.push({ path: entry.path, data: bytes.value });
        }
    };
    await walk('/');
    return { deleted: [], dirs, written };
}
export function createWasiFileSystem(store) {
    const nodes = new Map();
    let nextIno = 2;
    let baseline = new Map();
    const dirNode = (mode = DEFAULT_DIR_MODE, uid = 0, gid = 0) => {
        const now = Date.now();
        return { ino: nextIno++, nlink: 2, mode: S_IFDIR | (mode & 0o7777), uid, gid, atimeMs: now, mtimeMs: now, ctimeMs: now, birthtimeMs: now, children: new Set() };
    };
    const fileNode = (mode = DEFAULT_FILE_MODE, uid = 0, gid = 0) => {
        const now = Date.now();
        return { ino: nextIno++, nlink: 1, mode: S_IFREG | (mode & 0o7777), uid, gid, atimeMs: now, mtimeMs: now, ctimeMs: now, birthtimeMs: now, data: new Uint8Array(0) };
    };
    const isDirNode = (node) => node.children !== undefined;
    /** 空路径不是根：POSIX 里 '' 什么都指不到，归一化会把 '' 吞成 '/'，所以先挡在这里 */
    const at = (path) => (path === '' ? undefined : nodes.get(normalizePath(path)));
    const requireNode = (path) => {
        const node = at(path);
        if (!node)
            throw fsError('ENOENT', path);
        return node;
    };
    const requireDir = (path) => {
        const node = requireNode(path);
        if (!isDirNode(node))
            throw fsError('ENOTDIR', path);
        return node;
    };
    const touch = (node) => {
        const now = Date.now();
        node.mtimeMs = now;
        node.ctimeMs = now;
    };
    /** 挂名与摘名是目录 `children`/`nlink`/mtime 唯二改变的地方——放一起免得漂 */
    const attach = (path, node) => {
        if (path === '/')
            return;
        const parent = nodes.get(parentOf(path));
        if (!parent || !parent.children)
            return;
        parent.children.add(baseOf(path));
        if (isDirNode(node))
            parent.nlink++;
        touch(parent);
    };
    const detach = (path, node) => {
        if (path === '/')
            return;
        const parent = nodes.get(parentOf(path));
        if (!parent || !parent.children)
            return;
        parent.children.delete(baseOf(path));
        if (isDirNode(node))
            parent.nlink--;
        touch(parent);
    };
    const statOf = (node) => ({
        ino: node.ino, nlink: node.nlink, size: node.data?.length ?? 0, mode: node.mode,
        uid: node.uid, gid: node.gid, atimeMs: node.atimeMs, mtimeMs: node.mtimeMs,
        ctimeMs: node.ctimeMs, birthtimeMs: node.birthtimeMs,
    });
    const sample = () => {
        const out = new Map();
        for (const [path, node] of nodes)
            out.set(path, isDirNode(node) ? { dir: true } : { dir: false, data: node.data.slice() });
        return out;
    };
    const resetCache = () => {
        nodes.clear();
        nextIno = 2;
        nodes.set('/', dirNode());
        // guest 的临时面：mktemp/临时件要有个可写目录。挂载表的默认表也把 /tmp 指向内存面，
        // 这里建空目录是给「只挂 '/'」的注入形状兜底（worker 内 store 就是纯内存，靠这句才有 /tmp）。
        const tmp = dirNode();
        nodes.set('/tmp', tmp);
        attach('/tmp', tmp);
    };
    resetCache();
    const seed = async () => {
        const tree = await readMountTree(store);
        resetCache();
        for (const path of tree.dirs) {
            const abs = normalizePath(path);
            if (abs === '/' || nodes.has(abs))
                continue;
            const node = dirNode();
            nodes.set(abs, node);
            attach(abs, node);
        }
        for (const { path, data } of tree.written) {
            const abs = normalizePath(path);
            const node = fileNode();
            node.data = data.slice();
            nodes.set(abs, node);
            attach(abs, node);
        }
        baseline = sample();
    };
    const exportChanges = () => {
        const current = sample();
        const written = [];
        const dirs = [];
        const deleted = [];
        for (const [path, entry] of current) {
            if (path === '/')
                continue;
            const before = baseline.get(path);
            if (entry.dir) {
                // 目录：新建，或原来是同名的文件（类型变了 → 先删旧节点再建）
                if (!before?.dir)
                    dirs.push(path);
            }
            else if (!before || before.dir || !bytesEqual(before.data, entry.data)) {
                written.push({ path, data: entry.data });
            }
            if (before && before.dir !== entry.dir)
                deleted.push(path); // 类型变了：旧节点必须先消失
        }
        for (const path of baseline.keys())
            if (!current.has(path))
                deleted.push(path);
        deleted.sort(depthFirst);
        const top = [];
        for (const path of deleted)
            if (!top.some((q) => path === q || path.startsWith(`${q}/`)))
                top.push(path);
        dirs.sort(depthFirst);
        written.sort((a, b) => depthFirst(a.path, b.path));
        baseline = current;
        return { deleted: top, dirs, written };
    };
    /**
     * 当前全树快照（`deleted` 恒空），**不推进 drain 基线**。语义与 `readMountTree`（挂载树版本）一致，
     * 只是数据源换成缓存内的节点——worker 内没有挂载树可读（mounts 为空）。
     */
    const snapshot = () => {
        const dirs = [];
        const written = [];
        for (const [path, entry] of sample()) {
            if (path === '/')
                continue;
            if (entry.dir)
                dirs.push(path);
            else
                written.push({ path, data: entry.data });
        }
        dirs.sort(depthFirst);
        written.sort((a, b) => depthFirst(a.path, b.path));
        return { deleted: [], dirs, written };
    };
    /** 删一个节点及其整棵子树（applyChanges 的 deleted 段；目录只报最上层，子项还要一起清） */
    const removeNode = (path) => {
        const node = nodes.get(path);
        if (!node)
            return;
        if (isDirNode(node))
            for (const key of [...nodes.keys()])
                if (key.startsWith(`${path}/`))
                    nodes.delete(key);
        nodes.delete(path);
        detach(path, node);
    };
    const applyChanges = (changes) => {
        for (const path of changes.deleted)
            removeNode(normalizePath(path));
        for (const path of changes.dirs) {
            const abs = normalizePath(path);
            if (abs === '/' || nodes.has(abs))
                continue;
            const node = dirNode();
            nodes.set(abs, node);
            attach(abs, node);
        }
        for (const { path, data } of changes.written) {
            const abs = normalizePath(path);
            const existing = nodes.get(abs);
            if (existing && !isDirNode(existing)) {
                existing.data = data.slice();
                touch(existing);
                continue;
            }
            const node = fileNode();
            node.data = data.slice();
            nodes.set(abs, node);
            attach(abs, node);
        }
        baseline = sample();
    };
    return {
        statSync: (path) => statOf(requireNode(path)),
        readdirSync: (path) => [...requireDir(path).children],
        createFileSync: (path, options) => {
            const abs = normalizePath(path);
            if (nodes.has(abs))
                throw fsError('EEXIST', path);
            requireDir(parentOf(abs));
            const node = fileNode(options?.mode, options?.uid, options?.gid);
            nodes.set(abs, node);
            attach(abs, node);
            return statOf(node);
        },
        mkdirSync: (path, options) => {
            const abs = normalizePath(path);
            if (nodes.has(abs))
                throw fsError('EEXIST', path);
            requireDir(parentOf(abs));
            const node = dirNode(options?.mode, options?.uid, options?.gid);
            nodes.set(abs, node);
            attach(abs, node);
            return statOf(node);
        },
        rmdirSync: (path) => {
            const abs = normalizePath(path);
            const node = requireDir(path);
            if (abs === '/')
                throw fsError('EBUSY', path); // 删了根，之后每个路径都是 ENOENT
            if (node.children.size)
                throw fsError('ENOTEMPTY', path);
            nodes.delete(abs);
            detach(abs, node);
        },
        unlinkSync: (path) => {
            const abs = normalizePath(path);
            const node = requireNode(path);
            if (isDirNode(node))
                throw fsError('EISDIR', path);
            node.nlink--; // 还有第二个名字（linkSync）时节点活着，只是少一个名
            node.ctimeMs = Date.now();
            nodes.delete(abs);
            detach(abs, node);
        },
        renameSync: (from, to) => {
            const src = normalizePath(from);
            const dst = normalizePath(to);
            const node = requireNode(from);
            if (src === dst)
                return;
            if (src === '/')
                throw fsError('EBUSY', from);
            requireDir(parentOf(dst));
            if (isDirNode(node) && dst.startsWith(`${src}/`))
                throw fsError('EINVAL', to); // 移进自己
            // 所有拒绝都在动手之前判完：抛出的 rename 必须把树原样留下
            const existing = nodes.get(dst);
            if (existing) {
                const existingIsDir = isDirNode(existing);
                if (existingIsDir && !isDirNode(node))
                    throw fsError('EISDIR', to);
                if (!existingIsDir && isDirNode(node))
                    throw fsError('ENOTDIR', to);
                // 只有同类型目录才看空不空——文件没有 children（踩过：sed -i 的 temp→原名 rename
                // 会打到这里，用 `existing.children!.size` 非空断言会漏成 TypeError，shim 只能报 EIO）
                if (existingIsDir && existing.children.size)
                    throw fsError('ENOTEMPTY', to);
                existing.nlink--;
                nodes.delete(dst);
                detach(dst, existing);
            }
            // 表按整路径索引，所以目录改名时子树跟着换 key；节点对象不动 → ino 稳定
            if (isDirNode(node)) {
                for (const key of [...nodes.keys()]) {
                    if (!key.startsWith(`${src}/`))
                        continue;
                    nodes.set(dst + key.slice(src.length), nodes.get(key));
                    nodes.delete(key);
                }
            }
            detach(src, node);
            nodes.delete(src);
            nodes.set(dst, node);
            attach(dst, node);
            // 改名动的是元数据不是内容：bump mtime 会让 mv 过的文件在 find -newer 眼里像刚编辑过
            node.ctimeMs = Date.now();
        },
        linkSync: (target, link) => {
            const dst = normalizePath(link);
            const node = requireNode(target);
            if (isDirNode(node))
                throw fsError('EPERM', target); // POSIX：目录不给硬链接
            if (nodes.has(dst))
                throw fsError('EEXIST', link);
            requireDir(parentOf(dst));
            node.nlink++;
            node.ctimeMs = Date.now();
            nodes.set(dst, node); // 一个节点两个名字：同一个 ino、同一份字节
            attach(dst, node);
        },
        readSync: (path, buffer, start, end) => {
            const node = requireNode(path);
            if (isDirNode(node))
                throw fsError('EISDIR', path);
            const slice = node.data.subarray(start, end);
            const taken = Math.min(slice.length, buffer.length);
            buffer.set(slice.subarray(0, taken), 0);
            // 读到 EOF 之后要补零：shim 按自己的 clamp 报读到的字节数，留旧字节会变成凭空的内容
            if (taken < buffer.length)
                buffer.fill(0, taken);
            node.atimeMs = Date.now();
        },
        writeSync: (path, buffer, offset) => {
            const node = requireNode(path); // 不存在的路径 ENOENT（空 buffer 也一样）：这是 shim 唯一的写前存在性检查
            if (isDirNode(node))
                throw fsError('EISDIR', path);
            const end = offset + buffer.length;
            if (end > node.data.length) {
                const grown = new Uint8Array(end); // 越过 EOF 的写留零洞
                grown.set(node.data, 0);
                node.data = grown;
            }
            node.data.set(buffer, offset);
            touch(node);
        },
        // chmod + chown + utimes + truncate 合一：metadata 是 Partial<InodeLike>，只应用给了值的字段
        touchSync: (path, metadata) => {
            const node = requireNode(path);
            if (metadata.size !== undefined && !isDirNode(node)) {
                const size = metadata.size;
                if (size !== node.data.length) {
                    const next = new Uint8Array(size);
                    next.set(node.data.subarray(0, Math.min(size, node.data.length)), 0);
                    node.data = next;
                    touch(node);
                }
            }
            // 类型位是节点的身份，不是调用方能改的（POSIX chmod 不能把文件变成目录）
            if (metadata.mode !== undefined)
                node.mode = (node.mode & S_IFMT) | (metadata.mode & 0o7777);
            if (metadata.uid !== undefined)
                node.uid = metadata.uid;
            if (metadata.gid !== undefined)
                node.gid = metadata.gid;
            if (metadata.atimeMs !== undefined)
                node.atimeMs = metadata.atimeMs;
            if (metadata.mtimeMs !== undefined)
                node.mtimeMs = metadata.mtimeMs;
            node.ctimeMs = metadata.ctimeMs !== undefined ? metadata.ctimeMs : Date.now();
        },
        // 缓存就是 run 期间的真相源：落盘发生在 run 边界的 exportChanges，这里没有可同步的对象
        syncSync: () => { },
        seed,
        exportChanges,
        snapshot,
        applyChanges,
    };
}
