// debugger/src/panel/App.tsx —— 面板主组件:库选择/面包屑/工具栏/树/视图/状态栏。
// 所有 fs 调用经 runOp 集中:错误 → 状态栏;导航(onNavigated)后整树重置重载(spec §3)。
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_DB, type FsOp, type ListEntry, type OpValue } from '../shared/protocol';
import { callOp, onNavigated } from './transport';
import { Tree, type Dirs } from './Tree';
import { FileView } from './FileView';
import './panel.css';

const parentOf = (p: string): string => {
	const i = p.lastIndexOf('/');
	return i <= 0 ? '/' : p.slice(0, i);
};
const joinPath = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`);

export function App() {
	const [dbNames, setDbNames] = useState<string[]>([]);
	const [dbName, setDbName] = useState<string>(DEFAULT_DB);
	const [dirs, setDirs] = useState<Dirs>({});
	const [expanded, setExpanded] = useState<Set<string>>(new Set(['/']));
	const [selected, setSelected] = useState<ListEntry | null>(null);
	const [cwd, setCwd] = useState('/');
	const [status, setStatus] = useState<string>('');

	const runOp = useCallback(
		async (op: FsOp): Promise<OpValue | null> => {
			const r = await callOp(op, dbName);
			if (!r.ok) {
				setStatus(`✗ ${r.error.code}: ${r.error.message}`);
				return null;
			}
			return r.value;
		},
		[dbName],
	);

	const loadDir = useCallback(
		async (path: string): Promise<ListEntry[] | null> => {
			const v = await runOp({ kind: 'list', path });
			if (!v || v.kind !== 'list') return null;
			setDirs((d) => ({ ...d, [path]: v.entries }));
			return v.entries;
		},
		[runOp],
	);

	// 库列表:面板打开时拉一次;默认选中 DEFAULT_DB(若存在)
	useEffect(() => {
		void (async () => {
			const r = await callOp({ kind: 'databases' }, null);
			if (r.ok && r.value.kind === 'databases') {
				setDbNames(r.value.names);
				if (r.value.names.includes(DEFAULT_DB)) setDbName(DEFAULT_DB);
				else if (r.value.names.length > 0) setDbName(r.value.names[0]);
			} else if (!r.ok) {
				setStatus(`✗ ${r.error.code}: ${r.error.message}`);
			}
		})();
	}, []);

	// 首次/切库:重置树并加载根
	useEffect(() => {
		setDirs({});
		setExpanded(new Set(['/']));
		setSelected(null);
		setCwd('/');
		void loadDir('/');
	}, [dbName, loadDir]);

	// 页面导航:bridge 可能随旧文档销毁,ensureBridge 在下次调用自动重装;这里只重置 UI 态
	useEffect(() => {
		onNavigated(() => {
			setDirs({});
			setExpanded(new Set(['/']));
			setSelected(null);
			setCwd('/');
			void loadDir('/');
			setStatus('页面已导航,已重新加载');
		});
	}, [loadDir]);

	const toggleDir = useCallback(
		(entry: ListEntry) => {
			setCwd(entry.path);
			setExpanded((prev) => {
				const next = new Set(prev);
				if (next.has(entry.path)) next.delete(entry.path);
				else next.add(entry.path);
				return next;
			});
			void loadDir(entry.path);
		},
		[loadDir],
	);

	/** 写操作后的失效:reloadPaths 为受影响目录;选中文件自身也要重读 */
	const onMutated = useCallback(
		(reloadDirs: string[]) => {
			const targets = new Set<string>(['/', cwd]);
			for (const p of reloadDirs) {
				targets.add(parentOf(p));
				// 展开链上的目录全部重拉
				for (const e of expanded) if (p.startsWith(e + '/') || e === parentOf(p)) targets.add(e);
			}
			for (const t of targets) void loadDir(t);
			if (reloadDirs.includes(selected?.path ?? '')) setSelected(null);
		},
		[cwd, expanded, loadDir, selected],
	);

	const newFile = async () => {
		const name = window.prompt('新文件路径(相对当前目录):');
		if (!name) return;
		const p = name.startsWith('/') ? name : joinPath(cwd, name);
		const v = await runOp({ kind: 'write', path: p, content: '', encoding: 'text' });
		if (v?.kind === 'write') onMutated([p]);
	};

	const newDir = async () => {
		const name = window.prompt('新目录路径(相对当前目录):');
		if (!name) return;
		const p = name.startsWith('/') ? name : joinPath(cwd, name);
		const v = await runOp({ kind: 'mkdir', path: p });
		if (v?.kind === 'mkdir') onMutated([p]);
	};

	const refreshAll = () => {
		for (const d of ['/', ...expanded]) void loadDir(d);
		setStatus('已刷新');
	};

	const crumbs = cwd.split('/').filter(Boolean);
	return (
		<div className="app">
			<div className="toolbar">
				<select
					value={dbName}
					onChange={(e) => {
						setDbName(e.target.value);
					}}
					title="IndexedDB 库"
				>
					{dbNames.length === 0 && <option value={dbName}>{dbName}</option>}
					{dbNames.map((n) => (
						<option key={n} value={n}>
							{n}
						</option>
					))}
				</select>
				<div className="breadcrumb">
					<span className="crumb" onClick={() => setCwd('/')}>
						/
					</span>
					{crumbs.map((c, i) => (
						<span key={c + i} className="crumb" onClick={() => setCwd(joinPath('/' + crumbs.slice(0, i).join('/'), c))}>
							{c}/
						</span>
					))}
				</div>
				<button onClick={newFile}>+文件</button>
				<button onClick={newDir}>+目录</button>
				<button onClick={refreshAll}>刷新</button>
			</div>
			<div className="main">
				<div className="sidebar">
					<Tree dirs={dirs} expanded={expanded} selected={selected?.path ?? null} onToggleDir={toggleDir} onSelect={setSelected} />
				</div>
				<div className="content">
					{selected ? (
						<FileView entry={selected} runOp={runOp} onMutated={onMutated} />
					) : (
						<div className="placeholder">
							<div>选择左侧文件查看/编辑;点击目录展开。</div>
							<div className="placeholder-sub">
								调试器读写 IDB 落盘态;宿主页面有内存缓存,外部写入可能要等宿主 flush/刷新后才可见。
							</div>
						</div>
					)}
				</div>
			</div>
			<div className="statusbar">
				<span className="status-msg">{status}</span>
				<span className="status-hint">宿主页面可能需要刷新才能看到外部写入</span>
			</div>
		</div>
	);
}
