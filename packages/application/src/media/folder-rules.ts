/**
 * Pure folder-tree rules (no database): folders never form cycles and the tree is at most six
 * levels deep (depth 0–5). Unit-tested; the commands re-check the same rules inside the
 * transaction with the rows locked.
 */
export const MAX_FOLDER_DEPTH = 5;

export interface FolderNode {
  id: string;
  parentId: string | null;
}

/** Ids of the folder and every descendant (breadth-first). */
export const subtreeIds = (nodes: readonly FolderNode[], rootId: string): string[] => {
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const list = children.get(n.parentId) ?? [];
    list.push(n.id);
    children.set(n.parentId, list);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const c of children.get(id) ?? []) queue.push(c);
  }
  return out;
};

/** Height of the subtree below `rootId` (0 when it has no children). */
export const subtreeHeight = (nodes: readonly FolderNode[], rootId: string): number => {
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const list = children.get(n.parentId) ?? [];
    list.push(n.id);
    children.set(n.parentId, list);
  }
  const height = (id: string, guard: Set<string>): number => {
    if (guard.has(id)) return 0;
    guard.add(id);
    let h = 0;
    for (const c of children.get(id) ?? []) h = Math.max(h, 1 + height(c, guard));
    return h;
  };
  return height(rootId, new Set());
};

export type MoveCheck = { ok: true; newDepth: number } | { ok: false; code: 'CYCLE' | 'TOO_DEEP' | 'SAME_PARENT'; message: string };

/**
 * Can `folderId` move under `targetParentId` (null = library root)? `depthOf` gives the current
 * depth of the target parent.
 */
export const checkFolderMove = (
  nodes: readonly FolderNode[],
  folderId: string,
  targetParentId: string | null,
  targetParentDepth: number | null,
): MoveCheck => {
  const current = nodes.find((n) => n.id === folderId);
  if (current && current.parentId === targetParentId) return { ok: false, code: 'SAME_PARENT', message: 'The folder is already there.' };
  if (targetParentId) {
    if (subtreeIds(nodes, folderId).includes(targetParentId))
      return { ok: false, code: 'CYCLE', message: 'A folder cannot be moved into itself or one of its subfolders.' };
  }
  const newDepth = targetParentId ? (targetParentDepth ?? 0) + 1 : 0;
  const height = subtreeHeight(nodes, folderId);
  if (newDepth + height > MAX_FOLDER_DEPTH)
    return { ok: false, code: 'TOO_DEEP', message: `Folders can be nested at most ${MAX_FOLDER_DEPTH + 1} levels deep.` };
  return { ok: true, newDepth };
};
