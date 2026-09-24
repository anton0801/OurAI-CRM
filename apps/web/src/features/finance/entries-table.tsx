'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { EntryRow } from '@castlane/api-contracts';
import { Badge, DataTable, formatDate, type Column, type SortState } from '@castlane/ui';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { EntryStatus, Money, MoneyList, SourceText } from './common';

/**
 * Ledger rows (S55): Status, Type, Date, Amount, Allocation, Source. Amount columns are shown only
 * when the server sent them (they are omitted without the finance permission).
 */
export const EntriesTable = ({
  rows,
  caption = 'Financial entries',
  hasMore,
  loadingMore,
  onLoadMore,
  sort,
  onSortChange,
  hideAllocation,
  empty,
}: {
  rows: EntryRow[];
  caption?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  sort?: SortState;
  onSortChange?: (s: SortState) => void;
  hideAllocation?: boolean;
  empty?: React.ReactNode;
}) => {
  const router = useRouter();
  const wsPath = useWsPath();
  const { user } = useWorkspace();
  const showAmounts = rows.some((r) => r.netBase !== undefined || r.balances !== undefined);
  const columns: Column<EntryRow>[] = [
    { key: 'recognitionDate', header: 'Date', sortable: !!onSortChange, minWidth: 110, cell: (e) => formatDate(e.recognitionDate) },
    {
      key: 'title',
      header: 'Entry',
      sortable: !!onSortChange,
      sticky: true,
      minWidth: 220,
      cell: (e) => (
        <span className="flex min-w-0 flex-col">
          <Link href={wsPath(`/finance/entries/${e.id}`)} className="truncate font-medium text-fg hover:underline" onClick={(ev) => ev.stopPropagation()}>
            {e.title}
          </Link>
          {e.counterparty ? <span className="truncate text-[12px] text-fg-2">{e.counterparty}</span> : null}
        </span>
      ),
    },
    { key: 'type', header: 'Type', minWidth: 130, cell: (e) => label('entryType', e.type) },
    { key: 'state', header: 'Status', minWidth: 130, cell: (e) => <EntryStatus state={e.displayState} isReversal={e.isReversal} /> },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      minWidth: 140,
      hidden: !showAmounts,
      cell: (e) =>
        e.netBase === undefined ? <span className="text-fg-muted">—</span> : e.netBase === null ? <span className="text-[12px] text-warning">FX rate missing</span> : <Money value={e.netBase} />,
    },
    { key: 'balance', header: 'Open Balance', align: 'right', minWidth: 140, hidden: !showAmounts, cell: (e) => <MoneyList values={e.balances?.filter((b) => b.amount !== '0' && !/^-?0(\.0+)?$/.test(b.amount))} /> },
    {
      key: 'allocation',
      header: 'Allocation',
      minWidth: 180,
      hidden: hideAllocation,
      cell: (e) => (
        <span className="flex flex-wrap items-center gap-1">
          {e.projects.slice(0, 2).map((p) => (
            <Badge key={p.id}>{p.name}</Badge>
          ))}
          {e.projects.length > 2 ? <span className="text-[12px] text-fg-2">+{e.projects.length - 2}</span> : null}
          {e.unallocated ? <Badge tone="warning">Unallocated</Badge> : null}
          {e.netOnly ? <Badge tone="info">Net only</Badge> : null}
        </span>
      ),
    },
    { key: 'source', header: 'Source', minWidth: 170, cell: (e) => <SourceText source={e.source} /> },
  ];
  return (
    <DataTable
      caption={caption}
      rows={rows}
      columns={columns}
      getRowId={(e) => e.id}
      density={user.density}
      sort={sort}
      onSortChange={onSortChange}
      onRowClick={(e) => router.push(wsPath(`/finance/entries/${e.id}`))}
      hasMore={hasMore}
      loadingMore={loadingMore}
      onLoadMore={onLoadMore}
      empty={empty}
    />
  );
};
