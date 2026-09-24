'use client';
import { Dialog as D } from 'radix-ui';
import { ArrowRight, MagnifyingGlass } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { shellEndpoints, type SearchResult } from '@castlane/api-contracts';
import { humanize, Spinner, cn, useOverlayFocusReturn } from '@castlane/ui';
import { api } from '@/lib/api';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { NAV, QUICK_CREATE } from './nav';

interface Row {
  key: string;
  label: string;
  sub?: string;
  href: string;
  kind: 'command' | 'result';
}

/**
 * Cmd/Ctrl+K palette (640 px, up to 8 visible results). Debounce 250 ms, queries from 2
 * characters; commands only open forms or pages — they never execute financial operations.
 */
export const CommandPalette = ({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) => {
  const ws = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const focus = useOverlayFocusReturn(open);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) {
      setQ('');
      setResults([]);
    }
  }, [open]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      api
        .call(shellEndpoints.search, { params: { workspaceId: ws.workspace.id }, query: { q: term, limit: 8 } }, { signal: ctrl.signal })
        .then((r) => setResults(r.results))
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, ws.workspace.id]);

  const commands = useMemo<Row[]>(() => {
    const nav = NAV.flatMap((g) => g.items)
      .filter((i) => i.anyOf.length === 0 || can(i.anyOf))
      .map((i) => ({ key: `nav-${i.key}`, label: `Go to ${i.label}`, href: wsPath(i.href), kind: 'command' as const }));
    const create = QUICK_CREATE.filter((c) => can(c.anyOf)).map((c) => ({ key: `new-${c.href}`, label: c.label, href: wsPath(c.href), kind: 'command' as const }));
    const term = q.trim().toLowerCase();
    return [...create, ...nav].filter((c) => !term || c.label.toLowerCase().includes(term)).slice(0, term ? 5 : 8);
  }, [can, q, wsPath]);

  const rows: Row[] = [
    ...results.map((r) => ({ key: `${r.entityType}-${r.entityId}`, label: r.title, sub: `${humanize(r.entityType)}${r.status ? ` · ${humanize(r.status)}` : ''}${r.snippet ? ` · ${r.snippet}` : ''}`, href: r.href, kind: 'result' as const })),
    ...commands,
  ];
  useEffect(() => setActive(0), [q, results.length]);

  const go = (r: Row | undefined) => {
    if (!r) return;
    onOpenChange(false);
    router.push(r.href);
  };

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/35" />
        <D.Content {...focus} className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-32px)] max-w-[640px] -translate-x-1/2 overflow-hidden rounded-[16px] border border-line bg-surface shadow-[var(--shadow-overlay)]">
          <D.Title className="sr-only">Search and commands</D.Title>
          <D.Description className="sr-only">Type at least two characters to search records you can access.</D.Description>
          <div className="flex items-center gap-2 border-b border-line px-4">
            <MagnifyingGlass size={18} className="text-fg-2" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search projects, content, tasks… or type a command"
              aria-label="Search"
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={rows[active] ? `palette-${active}` : undefined}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(rows.length - 1, a + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  go(rows[active]);
                }
              }}
              className="h-14 w-full bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-muted"
            />
            {loading ? <Spinner size={16} label="Searching" /> : null}
          </div>
          <ul id="palette-list" role="listbox" className="max-h-[400px] overflow-y-auto p-2">
            {rows.length === 0 && q.trim().length >= 2 && !loading ? <li className="px-3 py-6 text-center text-[13px] text-fg-2">No accessible records match.</li> : null}
            {rows.map((r, i) => (
              <li
                key={r.key}
                id={`palette-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(r)}
                className={cn('flex cursor-pointer items-center gap-3 rounded-[8px] px-3 py-2', i === active && 'bg-surface-2')}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] text-fg">{r.label}</span>
                  {r.sub ? <span className="truncate text-[12px] text-fg-2">{r.sub}</span> : null}
                </span>
                <ArrowRight size={14} className="text-fg-2" aria-hidden />
              </li>
            ))}
          </ul>
          {q.trim().length >= 2 ? (
            <div className="border-t border-line px-4 py-2 text-right">
              <button type="button" className="text-[12px] font-semibold text-primary hover:underline" onClick={() => go({ key: 'all', label: '', href: wsPath(`/search?q=${encodeURIComponent(q.trim())}`), kind: 'command' })}>
                Show all results
              </button>
            </div>
          ) : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
};
