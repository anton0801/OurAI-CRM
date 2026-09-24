import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { checkFolderMove, MAX_FOLDER_DEPTH, subtreeHeight, subtreeIds, type FolderNode } from './folder-rules';

/** Random forest: every node's parent has a smaller index (acyclic by construction). */
const forestArb = fc.array(fc.nat(), { minLength: 1, maxLength: 40 }).map((seeds) =>
  seeds.map((s, i): FolderNode => ({ id: `f${i}`, parentId: i === 0 || s % 3 === 0 ? null : `f${s % i}` })),
);

const depthOf = (nodes: FolderNode[], id: string): number => {
  let d = 0;
  let cur = nodes.find((n) => n.id === id);
  while (cur?.parentId) {
    d++;
    cur = nodes.find((n) => n.id === cur!.parentId);
  }
  return d;
};

describe('folder tree rules (no cycles, depth ≤ 6 levels)', () => {
  it('never allows moving a folder into its own subtree', () => {
    fc.assert(
      fc.property(forestArb, fc.nat(), fc.nat(), (nodes, a, b) => {
        const folder = nodes[a % nodes.length]!;
        const target = nodes[b % nodes.length]!;
        const r = checkFolderMove(nodes, folder.id, target.id, depthOf(nodes, target.id));
        if (subtreeIds(nodes, folder.id).includes(target.id)) expect(r.ok).toBe(false);
      }),
    );
  });

  it('accepted moves keep every folder within the maximum depth', () => {
    fc.assert(
      fc.property(forestArb, fc.nat(), fc.nat(), (nodes, a, b) => {
        const folder = nodes[a % nodes.length]!;
        const target = nodes[b % nodes.length]!;
        const r = checkFolderMove(nodes, folder.id, target.id, depthOf(nodes, target.id));
        if (r.ok) {
          const moved = nodes.map((n) => (n.id === folder.id ? { ...n, parentId: target.id } : n));
          for (const id of subtreeIds(moved, folder.id)) expect(depthOf(moved, id)).toBeLessThanOrEqual(MAX_FOLDER_DEPTH);
          expect(r.newDepth).toBe(depthOf(moved, folder.id));
        }
      }),
    );
  });

  it('computes subtree height and refuses a move that would nest too deep', () => {
    const chain: FolderNode[] = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, parentId: i ? `c${i - 1}` : null }));
    expect(subtreeHeight(chain, 'c0')).toBe(3);
    const nodes = [...chain, { id: 'x0', parentId: null }, { id: 'x1', parentId: 'x0' }, { id: 'x2', parentId: 'x1' }];
    // x2 is at depth 2; moving c0 (height 3) under it gives depth 3 + 3 = 6 > 5.
    expect(checkFolderMove(nodes, 'c0', 'x2', 2)).toMatchObject({ ok: false, code: 'TOO_DEEP' });
    expect(checkFolderMove(nodes, 'c0', 'x1', 1)).toMatchObject({ ok: true, newDepth: 2 });
    expect(checkFolderMove(nodes, 'c1', 'c0', 0)).toMatchObject({ ok: false, code: 'SAME_PARENT' });
    expect(checkFolderMove(nodes, 'c0', 'c3', 3)).toMatchObject({ ok: false, code: 'CYCLE' });
    expect(checkFolderMove(nodes, 'c2', null, null)).toMatchObject({ ok: true, newDepth: 0 });
  });
});
