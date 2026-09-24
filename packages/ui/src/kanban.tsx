'use client';
import { useState, type ReactNode } from 'react';
import { cn } from './cn';

export interface KanbanColumn {
  key: string;
  label: string;
  wipLimit?: number;
  /** Explain why dropping here is not allowed (e.g. "Approval happens in Review"). */
  dropDisabledReason?: string;
}

/**
 * Board with 296 px columns and 16 px gaps. Drag and drop is a convenience; every move is also
 * available through the card's own "Move to" menu (keyboard alternative). The server validates
 * each move — a rejected move leaves the card where it was.
 */
export function Kanban<T>({
  columns,
  items,
  getId,
  getColumn,
  renderCard,
  onMove,
  label,
  emptyColumnText = 'Nothing here',
}: {
  columns: KanbanColumn[];
  items: T[];
  getId: (item: T) => string;
  getColumn: (item: T) => string;
  renderCard: (item: T) => ReactNode;
  onMove?: (item: T, toColumn: string) => void;
  label: string;
  emptyColumnText?: string;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  return (
    <div role="region" aria-label={label} className="flex gap-4 overflow-x-auto pb-2 [scroll-snap-type:x_mandatory] md:[scroll-snap-type:none]">
      {columns.map((col) => {
        const colItems = items.filter((i) => getColumn(i) === col.key);
        const overLimit = col.wipLimit !== undefined && colItems.length > col.wipLimit;
        return (
          <section
            key={col.key}
            aria-label={`${col.label}, ${colItems.length} items`}
            className={cn(
              'flex w-[296px] shrink-0 snap-start flex-col rounded-[12px] border border-line bg-surface-2',
              over === col.key && !col.dropDisabledReason && 'outline-2 outline-[var(--c-focus)]',
            )}
            onDragOver={(e) => {
              if (!dragging || col.dropDisabledReason) return;
              e.preventDefault();
              setOver(col.key);
            }}
            onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const item = items.find((i) => getId(i) === dragging);
              setDragging(null);
              if (item && getColumn(item) !== col.key && !col.dropDisabledReason) onMove?.(item, col.key);
            }}
            title={col.dropDisabledReason}
          >
            <header className="flex items-center justify-between px-3 py-2">
              <h3 className="text-[13px] font-semibold text-fg">{col.label}</h3>
              <span className={cn('rounded-[6px] px-1.5 text-[12px] tabular-nums', overLimit ? 'bg-warning-soft text-warning' : 'text-fg-2')}>
                {colItems.length}
                {col.wipLimit !== undefined ? ` / ${col.wipLimit}` : ''}
              </span>
            </header>
            {overLimit ? <p className="px-3 pb-2 text-[12px] text-warning">Work in progress is above the limit.</p> : null}
            <ol className="flex min-h-[80px] flex-col gap-2 px-2 pb-2">
              {colItems.length === 0 ? <li className="px-1 py-4 text-center text-[12px] text-fg-muted">{emptyColumnText}</li> : null}
              {colItems.map((item) => (
                <li
                  key={getId(item)}
                  draggable={!!onMove}
                  onDragStart={(e) => {
                    setDragging(getId(item));
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => setDragging(null)}
                  className={cn('rounded-[8px] border border-line bg-surface p-3', dragging === getId(item) && 'opacity-60')}
                >
                  {renderCard(item)}
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
