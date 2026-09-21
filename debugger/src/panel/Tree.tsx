// debugger/src/panel/Tree.tsx —— 懒加载目录树。
// dirs: path → 子项列表(undefined = 未加载);展开目录时由 App 决定是否拉取。
import type { ListEntry } from '../shared/protocol';

export type Dirs = Record<string, ListEntry[] | undefined>;

export interface TreeProps {
	dirs: Dirs;
	expanded: Set<string>;
	selected: string | null;
	onToggleDir: (entry: ListEntry) => void;
	onSelect: (entry: ListEntry) => void;
}

export function Tree({ dirs, expanded, selected, onToggleDir, onSelect }: TreeProps) {
	const root = dirs['/'];
	if (!root) return <div className="tree-empty">(未加载)</div>;
	return (
		<div className="tree">
			<NodeList level={0} items={root} {...{ dirs, expanded, selected, onToggleDir, onSelect }} />
		</div>
	);
}

function NodeList(props: {
	level: number;
	items: ListEntry[];
	dirs: Dirs;
	expanded: Set<string>;
	selected: string | null;
	onToggleDir: (entry: ListEntry) => void;
	onSelect: (entry: ListEntry) => void;
}) {
	const { level, items, dirs, expanded, selected, onToggleDir, onSelect } = props;
	// 目录在前、各自按名排序,与主包 ls 工具的呈现口径一致
	const sorted = [...items].sort((a, b) =>
		a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
	);
	return (
		<>
			{sorted.map((entry) => (
				<NodeRow key={entry.path} level={level} entry={entry} {...{ dirs, expanded, selected, onToggleDir, onSelect }} />
			))}
		</>
	);
}

function NodeRow(props: {
	level: number;
	entry: ListEntry;
	dirs: Dirs;
	expanded: Set<string>;
	selected: string | null;
	onToggleDir: (entry: ListEntry) => void;
	onSelect: (entry: ListEntry) => void;
}) {
	const { level, entry, dirs, expanded, selected, onToggleDir, onSelect } = props;
	const isOpen = expanded.has(entry.path);
	const children = isOpen ? dirs[entry.path] : undefined;
	return (
		<>
			<div
				className={`tree-row${selected === entry.path ? ' selected' : ''}`}
				style={{ paddingLeft: `${8 + level * 14}px` }}
				onClick={() => (entry.kind === 'directory' ? onToggleDir(entry) : onSelect(entry))}
				role="treeitem"
				aria-expanded={entry.kind === 'directory' ? isOpen : undefined}
			>
				<span className="tree-caret">{entry.kind === 'directory' ? (isOpen ? '▾' : '▸') : ''}</span>
				<span className={`tree-name kind-${entry.kind}`}>{entry.name}</span>
				{entry.kind === 'file' && <span className="tree-size">{entry.size}</span>}
			</div>
			{isOpen && children && (
				<NodeList level={level + 1} items={children} {...{ dirs, expanded, selected, onToggleDir, onSelect }} />
			)}
			{isOpen && children !== undefined && children.length === 0 && (
				<div className="tree-empty" style={{ paddingLeft: `${22 + level * 14}px` }}>(空)</div>
			)}
		</>
	);
}
