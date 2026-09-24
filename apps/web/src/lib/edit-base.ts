'use client';
import { useEffect, useRef, useState } from 'react';
import { isApiError } from '@castlane/api-client';

interface Versioned {
  rowVersion: number;
}

export interface EditBase<T extends Versioned> {
  /** If-Match for the save: the version this edit started from (not the latest one cached). */
  version: number | undefined;
  /** The record as it was when the edit started — diff the form against it to send only changes. */
  start: T | null;
  /** The newest copy of the record (live updates keep refreshing it). */
  latest: T | null;
  /** Someone else saved the record since this edit started. */
  changedMeanwhile: boolean;
  /** Call in the save's catch: true (and the Conflict dialog opens) for a 412 version conflict. */
  catchConflict: (e: unknown) => boolean;
  /** Props for <ConflictDialog />: Keep Editing re-bases, Reload Latest Version resets. */
  conflictDialog: { open: boolean; onOpenChange: (open: boolean) => void; onReload: () => void };
  /** Start over from the latest saved record (after an explicit reload, or after a save). */
  rebase: (next?: T) => void;
}

/**
 * The version an edit form works against (T162). Records shown in forms come from queries that
 * live updates refresh in the background; sending If-Match with that refreshed rowVersion would
 * let a save silently overwrite a change the member never saw, and resetting the form when it
 * changes would throw away what they typed. So the base is captured once — when the form opens or
 * starts editing another record — and moves only when the member decides:
 *
 * - after a 412 the Conflict dialog opens; Keep Editing re-bases onto the server's current version
 *   (the form still holds only the member's input, and forms send just the fields they changed);
 * - Reload Latest Version re-bases and calls `onReload(latest)` so the form shows the saved values
 *   (without `onReload` the page reloads).
 *
 * `open` defaults to true (page forms); `key` defaults to the record's id. With `clean` (the form
 * holds no unsaved input) and `onReload`, a newer record is adopted right away: nothing typed can be
 * lost, and forms that stay open after saving pick up their own saved version.
 */
export const useEditBase = <T extends Versioned>(
  record: T | null | undefined,
  opts: { open?: boolean; key?: string | number | null; onReload?: (latest: T) => void; refetch?: () => unknown; clean?: boolean } = {},
): EditBase<T> => {
  const open = opts.open ?? true;
  const latest = record ?? null;
  const identity = open && latest ? String(opts.key ?? (latest as unknown as { id?: string }).id ?? 'record') : null;
  const [state, setState] = useState<{ identity: string | null; start: T | null; version: number | undefined }>(() => ({
    identity,
    start: identity ? latest : null,
    version: identity ? latest?.rowVersion : undefined,
  }));
  let current = state;
  if (state.identity !== identity) {
    // Opened, closed or switched to another record: capture now (never on a version change).
    current = { identity, start: identity ? latest : null, version: identity ? latest?.rowVersion : undefined };
    setState(current);
  }
  const [conflict, setConflict] = useState<{ serverVersion: number | undefined } | null>(null);
  const [pendingReload, setPendingReload] = useState<number | null>(null);
  const onReload = useRef(opts.onReload);
  onReload.current = opts.onReload;

  const rebase = (next?: T) => {
    const r = next ?? latest;
    setState((s) => ({ ...s, start: r ?? s.start, version: r?.rowVersion ?? s.version }));
  };

  // Reload Latest Version: wait until the refreshed record is at least the server's version.
  useEffect(() => {
    if (pendingReload === null || !latest || latest.rowVersion < pendingReload) return;
    setPendingReload(null);
    setState((s) => ({ ...s, start: latest, version: latest.rowVersion }));
    onReload.current?.(latest);
  }, [pendingReload, latest]);

  // An untouched form follows the latest record (there is no input to lose or to write back).
  const follow = !!opts.clean && !!onReload.current && !!identity && !conflict && pendingReload === null && !!latest && latest.rowVersion > (current.version ?? 0);
  useEffect(() => {
    if (!follow || !latest) return;
    setState((s) => ({ ...s, start: latest, version: latest.rowVersion }));
    onReload.current?.(latest);
  }, [follow, latest]);

  const newest = () => Math.max(latest?.rowVersion ?? 0, conflict?.serverVersion ?? 0) || undefined;
  return {
    version: current.version ?? latest?.rowVersion,
    start: current.start,
    latest,
    changedMeanwhile: !!latest && current.version !== undefined && latest.rowVersion !== current.version,
    catchConflict: (e) => {
      if (!isApiError(e) || (e.code !== 'VERSION_CONFLICT' && e.status !== 412)) return false;
      setConflict({ serverVersion: e.currentVersion });
      return true;
    },
    conflictDialog: {
      open: !!conflict,
      onOpenChange: (o) => {
        if (o) return;
        // Keep Editing: the member has seen that the record changed; the next save may apply their
        // own changes on top of the current version.
        const v = newest();
        setConflict(null);
        if (v !== undefined) setState((s) => ({ ...s, version: v }));
      },
      onReload: () => {
        const target = newest();
        setConflict(null);
        if (!onReload.current) {
          window.location.reload();
          return;
        }
        setPendingReload(target ?? 0);
        if (latest && target !== undefined && latest.rowVersion < target) void opts.refetch?.();
      },
    },
    rebase,
  };
};

/** Fields whose value differs from the start of the edit (shallow; arrays and objects by JSON). */
export const changedFields = <V extends Record<string, unknown>>(start: V, now: V): (keyof V)[] =>
  (Object.keys(now) as (keyof V)[]).filter((k) => {
    const a = start[k];
    const b = now[k];
    if (a === b) return false;
    if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
    return true;
  });

/** Only the changed keys of a payload (keeps the payload's own value transformations). */
export const pickChanged = <B extends Record<string, unknown>>(body: B, changed: readonly PropertyKey[]): Partial<B> =>
  Object.fromEntries(Object.entries(body).filter(([k]) => changed.includes(k))) as Partial<B>;
