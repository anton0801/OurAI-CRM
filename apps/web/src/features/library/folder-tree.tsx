'use client';
import { CaretDown, CaretRight, DotsThree, Folder, FolderOpen, HardDrives } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import type { FolderView } from '@castlane/api-contracts';
import { IconButton, Menu, cn, type MenuItem } from '@castlane/ui';

export type FolderAction = 'create' | 'rename' | 'move' | 'archive';

interface Node {
  folder: FolderView;
  children: Node[];
}

const buildTree = (folders: FolderView[]) => {
  const byId = new Map<string, Node>(folders.map((f) => [f.id, { folder: f, children: [] }]));
  const roots: Node[] = [];
  for (const n of byId.values()) {
    const parent = n.folder.parentId ? byId.get(n.folder.parentId) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const sort = (list: Node[]) => {
    list.sort((a, b) => a.folder.name.localeCompare(b.folder.name, undefined, { sensitivity: 'base' }));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return { roots, byId };
};

/** Ids of the folder and all its ancestors (to keep the selected folder expanded). */
export const ancestorsOf = (folders: FolderView[], id: string | null | undefined) => {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = new Set<string>();
  let cur = id ? byId.get(id) : undefined;
  while (cur) {
    out.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
};

/**
 * Logical folder tree (S36). Folders never change access by themselves; a folder of a project is
 * labelled with the project. Every action is reachable by keyboard (no drag and drop required).
 */
export const FolderTree = ({
  folders,
  selectedId,
  onSelect,
  onAction,
  canCreateRoot,
}: {
  folders: FolderView[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAction: (action: FolderAction, folder: FolderView | null) => void;
  canCreateRoot: boolean;
}) => {
  const { roots } = useMemo(() => buildTree(folders), [folders]);
  const [open, setOpen] = useState<Set<string>>(() => ancestorsOf(folders, selectedId));
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const isOpen = (id: string) => open.has(id) || ancestorsOf(folders, selectedId).has(id);

  const renderNode = (n: Node, level: number) => {
    const f = n.folder;
    const expanded = isOpen(f.id);
    const selected = selectedId === f.id;
    const menu: MenuItem[] = [
      { label: 'New Subfolder', onSelect: () => onAction('create', f), hidden: !f.permissions.create },
      { label: 'Rename', onSelect: () => onAction('rename', f), hidden: !f.permissions.update },
      { label: 'Move', onSelect: () => onAction('move', f), hidden: !f.permissions.update },
      { label: 'Archive', destructive: true, separatorBefore: true, onSelect: () => onAction('archive', f), hidden: !f.permissions.archive },
    ];
    return (
      <li key={f.id} role="treeitem" aria-expanded={n.children.length ? expanded : undefined} aria-selected={selected}>
        <div className={cn('group flex items-center gap-1 rounded-[8px] pr-1', selected ? 'bg-selection' : 'hover:bg-surface-2')} style={{ paddingLeft: 4 + level * 14 }}>
          {n.children.length ? (
            <button type="button" className="rounded p-1 text-fg-2 hover:text-fg" aria-label={expanded ? `Collapse ${f.name}` : `Expand ${f.name}`} onClick={() => toggle(f.id)}>
              {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
            </button>
          ) : (
            <span className="w-[20px]" aria-hidden />
          )}
          <button type="button" className="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-left text-[13px] text-fg" onClick={() => onSelect(f.id)} aria-current={selected ? 'true' : undefined}>
            {selected ? <FolderOpen size={16} className="shrink-0 text-fg-2" aria-hidden /> : <Folder size={16} className="shrink-0 text-fg-2" aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            {f.projectName && level === 0 ? <span className="hidden max-w-[80px] truncate text-[11px] text-fg-muted xl:inline">{f.projectName}</span> : null}
          </button>
          {menu.some((m) => !m.hidden) ? <Menu label={`Folder actions for ${f.name}`} trigger={<IconButton label={`Folder actions for ${f.name}`} icon={<DotsThree size={16} weight="bold" />} tooltip={false} />} items={menu} /> : null}
        </div>
        {n.children.length && expanded ? (
          <ul role="group" className="flex flex-col">
            {n.children.map((c) => renderNode(c, level + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <nav aria-label="Folders" className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => onSelect(null)}
        aria-current={selectedId === null ? 'true' : undefined}
        className={cn('flex min-h-9 items-center gap-2 rounded-[8px] px-2 text-left text-[13px] font-medium text-fg', selectedId === null ? 'bg-selection' : 'hover:bg-surface-2')}
      >
        <HardDrives size={16} className="text-fg-2" aria-hidden /> All Files
      </button>
      {roots.length ? (
        <ul role="tree" aria-label="Folder tree" className="flex flex-col">
          {roots.map((n) => renderNode(n, 0))}
        </ul>
      ) : (
        <p className="px-2 py-1 text-[12px] text-fg-2">No folders yet.</p>
      )}
      {canCreateRoot ? (
        <button type="button" className="mt-1 rounded-[8px] px-2 py-1.5 text-left text-[13px] font-medium text-primary hover:bg-surface-2" onClick={() => onAction('create', null)}>
          + New Folder
        </button>
      ) : null}
    </nav>
  );
};
