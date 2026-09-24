/**
 * Finish-to-Start dependency graph helpers (pure). Edges point predecessor → successor.
 */
export interface DependencyEdge {
  predecessorId: string;
  successorId: string;
}

const adjacency = (edges: readonly DependencyEdge[]) => {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const list = out.get(e.predecessorId);
    if (list) list.push(e.successorId);
    else out.set(e.predecessorId, [e.successorId]);
  }
  return out;
};

/** Ids reachable from `start` following edges (excluding `start` unless it lies on a cycle). */
export const reachableFrom = (edges: readonly DependencyEdge[], start: string): Set<string> => {
  const adj = adjacency(edges);
  const seen = new Set<string>();
  const stack = [...(adj.get(start) ?? [])];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of adj.get(n) ?? []) if (!seen.has(m)) stack.push(m);
  }
  return seen;
};

/**
 * Adding predecessor → successor closes a cycle when the predecessor is already reachable from the
 * successor (or it is a self-edge). Returns the offending path for the error message.
 */
export const cyclePath = (edges: readonly DependencyEdge[], predecessorId: string, successorId: string): string[] | null => {
  if (predecessorId === successorId) return [predecessorId, successorId];
  const adj = adjacency(edges);
  const prev = new Map<string, string | null>([[successorId, null]]);
  const queue = [successorId];
  while (queue.length) {
    const n = queue.shift()!;
    if (n === predecessorId) {
      const path: string[] = [];
      let cur: string | null = n;
      while (cur !== null) {
        path.unshift(cur);
        cur = prev.get(cur) ?? null;
      }
      return [predecessorId, ...path];
    }
    for (const m of adj.get(n) ?? []) {
      if (prev.has(m)) continue;
      prev.set(m, n);
      queue.push(m);
    }
  }
  return null;
};

export const createsCycle = (edges: readonly DependencyEdge[], predecessorId: string, successorId: string): boolean =>
  cyclePath(edges, predecessorId, successorId) !== null;

/** True when the graph is acyclic (Kahn's algorithm). */
export const isAcyclic = (edges: readonly DependencyEdge[]): boolean => {
  const nodes = new Set<string>();
  const indeg = new Map<string, number>();
  for (const e of edges) {
    nodes.add(e.predecessorId);
    nodes.add(e.successorId);
    indeg.set(e.successorId, (indeg.get(e.successorId) ?? 0) + 1);
  }
  const adj = adjacency(edges);
  const queue = [...nodes].filter((n) => !indeg.get(n));
  let visited = 0;
  while (queue.length) {
    const n = queue.shift()!;
    visited++;
    for (const m of adj.get(n) ?? []) {
      const d = (indeg.get(m) ?? 0) - 1;
      indeg.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  return visited === nodes.size;
};

/** Topological order of the nodes reachable from `roots` (roots first). Assumes an acyclic graph. */
export const topoFrom = (edges: readonly DependencyEdge[], roots: readonly string[]): string[] => {
  const reach = new Set<string>(roots);
  for (const r of roots) for (const n of reachableFrom(edges, r)) reach.add(n);
  const sub = edges.filter((e) => reach.has(e.predecessorId) && reach.has(e.successorId));
  const indeg = new Map<string, number>([...reach].map((n) => [n, 0]));
  for (const e of sub) indeg.set(e.successorId, (indeg.get(e.successorId) ?? 0) + 1);
  const adj = adjacency(sub);
  const queue = [...reach].filter((n) => indeg.get(n) === 0);
  const out: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    out.push(n);
    for (const m of adj.get(n) ?? []) {
      const d = (indeg.get(m) ?? 0) - 1;
      indeg.set(m, d);
      if (d === 0) queue.push(m);
    }
  }
  return out;
};

export interface ScheduledNode {
  id: string;
  startAt: Date | null;
  dueAt: Date | null;
  /** Date-only deadlines move in whole days. */
  dateOnly: boolean;
  open: boolean;
}

export interface ScheduleChange {
  id: string;
  fromStart: Date | null;
  toStart: Date | null;
  fromDue: Date | null;
  toDue: Date | null;
  /** The task that pushed this one (null for the rescheduled task itself). */
  causedBy: string | null;
}

const DAY = 86_400_000;

/**
 * Finish-to-Start propagation preview: after moving `rootId` to new dates, every open successor
 * that would start (or, without a start, be due) before a predecessor's new deadline is pushed
 * later by the minimal amount — date-only deadlines by whole days. Nothing is ever pulled earlier
 * and closed tasks never move. Pure: the caller decides which changes to apply.
 */
export const propagateSchedule = (
  nodes: ReadonlyMap<string, ScheduledNode>,
  edges: readonly DependencyEdge[],
  root: { id: string; startAt: Date | null; dueAt: Date | null },
): ScheduleChange[] => {
  const current = new Map<string, { startAt: Date | null; dueAt: Date | null }>();
  for (const [id, n] of nodes) current.set(id, { startAt: n.startAt, dueAt: n.dueAt });
  const orig = nodes.get(root.id);
  const changes = new Map<string, ScheduleChange>();
  changes.set(root.id, {
    id: root.id,
    fromStart: orig?.startAt ?? null,
    toStart: root.startAt,
    fromDue: orig?.dueAt ?? null,
    toDue: root.dueAt,
    causedBy: null,
  });
  current.set(root.id, { startAt: root.startAt, dueAt: root.dueAt });
  const order = topoFrom(edges, [root.id]);
  const preds = new Map<string, string[]>();
  for (const e of edges) {
    const l = preds.get(e.successorId);
    if (l) l.push(e.predecessorId);
    else preds.set(e.successorId, [e.predecessorId]);
  }
  for (const id of order) {
    if (id === root.id) continue;
    const n = nodes.get(id);
    if (!n || !n.open) continue;
    let latest: { at: number; by: string } | null = null;
    for (const p of preds.get(id) ?? []) {
      const pd = current.get(p)?.dueAt;
      if (pd && (!latest || pd.getTime() > latest.at)) latest = { at: pd.getTime(), by: p };
    }
    if (!latest) continue;
    const cur = current.get(id)!;
    const anchor = cur.startAt ?? cur.dueAt;
    if (!anchor || anchor.getTime() >= latest.at) continue;
    let shift = latest.at - anchor.getTime();
    if (n.dateOnly) shift = Math.ceil(shift / DAY) * DAY;
    const next = {
      startAt: cur.startAt ? new Date(cur.startAt.getTime() + shift) : null,
      dueAt: cur.dueAt ? new Date(cur.dueAt.getTime() + shift) : null,
    };
    current.set(id, next);
    changes.set(id, { id, fromStart: n.startAt, toStart: next.startAt, fromDue: n.dueAt, toDue: next.dueAt, causedBy: latest.by });
  }
  return [...changes.values()];
};
