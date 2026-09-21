// debugger/src/panel/FileView.tsx —— 右侧文件查看/编辑器。
// 文本:预览(截断时禁编辑并提示)→ 编辑 → 保存;二进制:base64 只读占位。
// 写路径全部经 App 传入的 runOp(集中错误与状态显示)。
import { useEffect, useState } from 'react';
import { DEFAULT_MAX_BYTES, type FsOp, type ListEntry, type OpValue } from '../shared/protocol';

export interface FileViewProps {
	entry: ListEntry;
	runOp: (op: FsOp) => Promise<OpValue | null>;
	onMutated: (reloadDirs: string[]) => void;
}

export function FileView({ entry, runOp, onMutated }: FileViewProps) {
	const [content, setContent] = useState<string | null>(null);
	const [encoding, setEncoding] = useState<'text' | 'base64'>('text');
	const [totalBytes, setTotalBytes] = useState(0);
	const [truncated, setTruncated] = useState(false);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState('');
	const [loadedPath, setLoadedPath] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		setContent(null);
		setEditing(false);
		(async () => {
			const v = await runOp({ kind: 'read', path: entry.path, maxBytes: DEFAULT_MAX_BYTES });
			if (!alive || !v || v.kind !== 'read') return;
			setEncoding(v.encoding);
			setTotalBytes(v.totalBytes);
			setTruncated('truncated' in v ? v.truncated : false);
			setContent(v.content);
			setDraft(v.content);
			setLoadedPath(entry.path);
		})();
		return () => {
			alive = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- runOp 由 App 用 useCallback 固定
	}, [entry.path]);

	if (loadedPath !== entry.path) return <div className="fileview">加载中…</div>;

	const isText = encoding === 'text' && !truncated;

	const save = async () => {
		const v = await runOp({ kind: 'write', path: entry.path, content: draft, encoding: 'text' });
		if (v?.kind === 'write') {
			setEditing(false);
			setContent(draft);
			// 尺寸变了,父目录列表刷新
			onMutated([entry.path]);
		}
	};

	const del = async () => {
		if (!window.confirm(`删除 ${entry.path}?`)) return;
		const v = await runOp({ kind: 'delete', path: entry.path, recursive: false });
		if (v?.kind === 'delete') onMutated([]);
	};

	const rename = async () => {
		const to = window.prompt('重命名为(绝对路径):', entry.path);
		if (!to || to === entry.path) return;
		const v = await runOp({ kind: 'rename', from: entry.path, to });
		if (v?.kind === 'rename') onMutated([entry.path]);
	};

	return (
		<div className="fileview">
			<div className="fileview-toolbar">
				<span className="fileview-path" title={entry.path}>
					{entry.path}
				</span>
				<span className="fileview-meta">{totalBytes} B</span>
				{isText && !editing && <button onClick={() => setEditing(true)}>编辑</button>}
				{isText && editing && (
					<>
						<button className="primary" onClick={save}>
							保存
						</button>
						<button
							onClick={() => {
								setEditing(false);
								setDraft(content ?? '');
							}}
						>
							取消
						</button>
					</>
				)}
				<button onClick={rename}>重命名</button>
				<button className="danger" onClick={del}>
					删除
				</button>
			</div>
			{truncated && (
				<div className="fileview-note warn">
					文件超过 {DEFAULT_MAX_BYTES} 字节,预览已截断(共 {totalBytes} B);截断态不提供编辑,避免半文件覆盖。
				</div>
			)}
			{encoding === 'base64' ? (
				<div className="fileview-note">二进制文件(NUL 探测命中),base64 只读预览:</div>
			) : null}
			{editing ? (
				<textarea className="editor" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
			) : content !== null && encoding === 'base64' ? (
				<pre className="preview">{content.length > 8192 ? `${content.slice(0, 8192)}\n…(base64 截断)` : content}</pre>
			) : content !== null ? (
				<pre className="preview">{content}</pre>
			) : (
				<div className="fileview-note">(空文件)</div>
			)}
		</div>
	);
}
