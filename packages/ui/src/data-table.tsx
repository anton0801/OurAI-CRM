'use client';
import { ArrowDown, ArrowUp, ArrowsDownUp } from '@phosphor-icons/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef, type ReactNode } from 'react';
import { Button } from './button';
import { Checkbox } from './choice';
import { cn } from './cn';
import { TableSkeleton } from './states';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Minimum width in px (tables scroll horizontally inside their container, never the page). */
  minWidth?: number;
  width?: number;
  sortable?: boolean;
  /** Sticky first meaningful column. */
  sticky?: boolean;
  hidden?: boolean;
  /** Accessible header text when `header` is not a string. */
  headerLabel?: string;
}

export interface SortState {
  key: string;
  direction: 'asc' | 'desc';
}

export interface SelectionState {
  /** Explicitly selected ids (Select Visible). */
  ids: Set<string>;
  /** "Select All Matching" — every record matching the current filter, including unloaded pages. */
  allMatching: boolean;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  getRowId: (row: T) => string;
  caption: string;
  loading?: boolean;
  density?: 'comfortable' | 'compact';
  sort?: SortState | null;
  onSortChange?: (s: SortState) => void;
  onRowClick?: (row: T) => void;
  selection?: SelectionState;
  onSelectionChange?: (s: SelectionState) => void;
  /** Total matching records (only when the server provided an exact count). */
  totalMatching?: number | null;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  empty?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
  selectedRowId?: string | null;
  /** Virtualise when there are many loaded rows. */
  virtualizeAbove?: number;
  maxHeight?: number;
}

export function DataTable<T>(p: DataTableProps<T>) {
  const {
    rows,
    columns: allColumns,
    getRowId,
    caption,
    loading,
    density = 'comfortable',
    sort,
    onSortChange,
    onRowClick,
    selection,
    onSelectionChange,
    hasMore,
    loadingMore,
    onLoadMore,
    empty,
    rowClassName,
    selectedRowId,
    virtualizeAbove = 200,
    maxHeight = 720,
  } = p;
  const columns = allColumns.filter((c) => !c.hidden);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowHeight = density === 'compact' ? 36 : 48;
  const virtual = rows.length > virtualizeAbove;
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  if (loading) return <TableSkeleton columns={Math.min(columns.length, 6)} />;
  if (rows.length === 0 && empty) return <>{empty}</>;

  const selectable = !!selection && !!onSelectionChange;
  const visibleIds = rows.map(getRowId);
  const selectedVisible = selection ? visibleIds.filter((id) => selection.allMatching || selection.ids.has(id)).length : 0;
  const headerState: boolean | 'indeterminate' =
    selectedVisible === 0 ? false : selectedVisible === visibleIds.length ? true : 'indeterminate';

  const renderRow = (row: T, index: number, style?: React.CSSProperties) => {
    const id = getRowId(row);
    const checked = !!selection && (selection.allMatching || selection.ids.has(id));
    return (
      <tr
        key={id}
        data-index={index}
        style={style}
        aria-selected={selectable ? checked : undefined}
        tabIndex={onRowClick ? 0 : undefined}
        onClick={onRowClick ? () => onRowClick(row) : undefined}
        onKeyDown={
          onRowClick
            ? (e) => {
                if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row);
              }
            : undefined
        }
        className={cn(
          'group border-b border-line last:border-b-0',
          onRowClick && 'cursor-pointer hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--c-focus)]',
          (checked || selectedRowId === id) && 'bg-selection',
          rowClassName?.(row),
        )}
      >
        {selectable && (
          <td className="w-9 px-3" onClick={(e) => e.stopPropagation()}>
            <Checkbox
              aria-label={`Select row`}
              checked={checked}
              onCheckedChange={(v) => {
                const ids = new Set(selection!.allMatching ? visibleIds : selection!.ids);
                if (v) ids.add(id);
                else ids.delete(id);
                onSelectionChange!({ ids, allMatching: false });
              }}
            />
          </td>
        )}
        {columns.map((c) => (
          <td
            key={c.key}
            className={cn(
              'px-3 text-[13px] leading-5 text-fg',
              density === 'compact' ? 'h-9' : 'h-12',
              c.align === 'right' && 'text-right font-mono tabular-nums',
              c.align === 'center' && 'text-center',
              c.sticky && 'sticky left-0 z-[1] bg-surface group-hover:bg-surface-2',
              (checked || selectedRowId === id) && c.sticky && 'bg-selection',
            )}
            style={{ minWidth: c.minWidth, width: c.width }}
          >
            {c.cell(row)}
          </td>
        ))}
      </tr>
    );
  };

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-2">
      {selectable && selection && (selection.ids.size > 0 || selection.allMatching) ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[8px] bg-selection px-3 py-2 text-[13px] text-fg" role="status">
          <span>
            {selection.allMatching
              ? `All ${p.totalMatching ?? ''} matching records selected`.replace('  ', ' ')
              : `${selection.ids.size} selected on this page`}
          </span>
          {!selection.allMatching && hasMore ? (
            <Button size="sm" variant="ghost" onClick={() => onSelectionChange!({ ids: new Set(), allMatching: true })}>
              Select All Matching{p.totalMatching ? ` (${p.totalMatching})` : ''}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => onSelectionChange!({ ids: new Set(), allMatching: false })}>
            Clear Selection
          </Button>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className="relative min-w-0 max-w-full overflow-auto rounded-[12px] border border-line bg-surface"
        style={virtual ? { maxHeight } : undefined}
        tabIndex={0}
        role="region"
        aria-label={caption}
      >
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 z-[2] bg-surface">
            <tr className="h-10 border-b border-line">
              {selectable && (
                <th scope="col" className="w-9 px-3">
                  <Checkbox
                    aria-label="Select visible rows"
                    checked={headerState}
                    onCheckedChange={(v) => onSelectionChange!({ ids: v ? new Set(visibleIds) : new Set(), allMatching: false })}
                  />
                </th>
              )}
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (sort!.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                    className={cn(
                      'whitespace-nowrap px-3 text-[12px] font-[550] leading-[18px] text-fg-2',
                      c.align === 'right' && 'text-right',
                      c.align === 'center' && 'text-center',
                      c.sticky && 'sticky left-0 z-[3] bg-surface',
                    )}
                    style={{ minWidth: c.minWidth, width: c.width }}
                  >
                    {c.sortable && onSortChange ? (
                      <button
                        type="button"
                        className={cn('inline-flex items-center gap-1 hover:text-fg', c.align === 'right' && 'flex-row-reverse')}
                        onClick={() => onSortChange({ key: c.key, direction: active && sort!.direction === 'asc' ? 'desc' : 'asc' })}
                      >
                        {c.header}
                        {active ? (
                          sort!.direction === 'asc' ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />
                        ) : (
                          <ArrowsDownUp size={12} aria-hidden className="opacity-50" />
                        )}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody style={virtual ? { height: virtualizer.getTotalSize(), position: 'relative' } : undefined}>
            {virtual
              ? virtualizer.getVirtualItems().map((vi) =>
                  renderRow(rows[vi.index]!, vi.index, {
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    display: 'table',
                    tableLayout: 'fixed',
                    transform: `translateY(${vi.start}px)`,
                  }),
                )
              : rows.map((r, i) => renderRow(r, i))}
          </tbody>
        </table>
      </div>
      {hasMore && onLoadMore ? (
        <div className="flex justify-center">
          <Button onClick={onLoadMore} loading={loadingMore}>
            Load More
          </Button>
        </div>
      ) : null}
    </div>
  );
}
