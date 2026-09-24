'use client';
import Link from 'next/link';
import { Coins } from '@phosphor-icons/react';
import { financeEndpoints as F, type MemberCompensation, type RunLineView } from '@castlane/api-contracts';
import { Badge, DataTable, EmptyState, Panel, StatusBadge, formatDate, formatNumber, type Column } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { Money, MoneyList, useFinanceParams } from './common';

/** Source lines of a calculation: what was counted, how, and why something was excluded. */
export const RunLinesTable = ({ lines, caption, showRecipient }: { lines: RunLineView[]; caption: string; showRecipient?: boolean }) => {
  const { user } = useWorkspace();
  const columns: Column<RunLineView>[] = [
    { key: 'recipient', header: 'Recipient', minWidth: 160, hidden: !showRecipient, sticky: showRecipient, cell: (l) => l.recipient.displayName },
    {
      key: 'source',
      header: 'Source',
      minWidth: 220,
      sticky: !showRecipient,
      cell: (l) => (
        <span className="flex flex-col">
          <span className="text-fg">{l.sourceLabel ?? label('compensationSource', l.sourceType)}</span>
          <span className="text-[12px] text-fg-2">
            {label('compensationSource', l.sourceType)}
            {l.ruleName ? ` · ${l.ruleName}` : ''}
          </span>
        </span>
      ),
    },
    { key: 'component', header: 'Component', minWidth: 130, cell: (l) => l.component },
    { key: 'qty', header: 'Quantity', align: 'right', minWidth: 90, cell: (l) => (l.quantity === null ? '—' : formatNumber(l.quantity, { maximumFractionDigits: 4 })) },
    { key: 'rate', header: 'Rate', align: 'right', minWidth: 100, cell: (l) => l.rate ?? '—' },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      minWidth: 130,
      cell: (l) => (l.excluded ? <span className="text-fg-muted line-through"><Money value={l.amount} /></span> : <Money value={l.amount} />),
    },
    {
      key: 'status',
      header: 'Status',
      minWidth: 200,
      cell: (l) => (l.excluded ? <span className="text-[12px] text-warning">Excluded: {l.exclusionReason ?? 'not eligible'}</span> : <Badge tone="success">Counted</Badge>),
    },
  ];
  return <DataTable caption={caption} rows={lines} columns={columns} getRowId={(l) => l.id} density={user.density} maxHeight={480} />;
};

/**
 * Member compensation (Member Workspace tab and own pay view): rules in effect, calculated runs
 * with their source lines, payments recorded and outstanding balance. Payments are records of
 * money already paid; nothing here transfers money.
 */
export const MemberCompensationView = ({ membershipId, own }: { membershipId: string; own?: boolean }) => {
  const params = useFinanceParams();
  const can = useCan();
  const wsPath = useWsPath();
  const q = useApiQuery(F.memberCompensation, { params: { ...params, membershipId } });
  const canOpenRuns = can('compensation.runs.read');
  return (
    <QueryState query={q}>
      {q.data ? <Body data={q.data} own={own} canOpenRuns={canOpenRuns} runHref={(id) => wsPath(`/finance/compensation/runs/${id}`)} /> : null}
    </QueryState>
  );
};

const Body = ({ data, own, canOpenRuns, runHref }: { data: MemberCompensation; own?: boolean; canOpenRuns: boolean; runHref: (id: string) => string }) => {
  if (data.rules.length === 0 && data.runs.length === 0)
    return (
      <EmptyState
        icon={<Coins size={28} />}
        title="No compensation recorded"
        description={own ? 'No compensation rules or calculations include you yet.' : 'No compensation rules or calculations include this member yet.'}
      />
    );
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Panel title="Outstanding" description="Approved and not yet recorded as paid">
          <MoneyList values={data.outstanding} empty="Nothing outstanding" />
        </Panel>
        <Panel title="Carry-forward" description="Negative balance offset in the next run">
          <MoneyList values={data.carryForward} empty="None" />
        </Panel>
        <Panel title="Pending Adjustments">
          {data.pendingAdjustments.length === 0 ? (
            <p className="text-[13px] text-fg-2">None</p>
          ) : (
            <ul className="flex flex-col gap-1 text-[13px]">
              {data.pendingAdjustments.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-2">
                  <span>{label('adjustmentKind', a.kind)}</span>
                  <Money value={a.amount} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <Panel title="Rules">
        {data.rules.length === 0 ? (
          <p className="text-[13px] text-fg-2">No rules in effect.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {data.rules.map((r) => {
              const v = r.currentVersion;
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="flex flex-col">
                    <span className="font-medium text-fg">{r.name}</span>
                    <span className="text-[12px] text-fg-2">
                      {v ? `${label('ruleType', v.type)} · from ${formatDate(v.effectiveFrom)}${v.effectiveTo ? ` to ${formatDate(v.effectiveTo)}` : ''}` : 'No approved version'}
                    </span>
                  </span>
                  <span className="text-[13px]">{v ? (v.ratePercent ? `${v.ratePercent}% of ${label('revenueBasis', v.revenueBasis)}` : v.rate ? <Money value={v.rate} /> : '—') : null}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      {data.runs.map((r) => (
        <Panel
          key={r.run.id}
          title={`${formatDate(r.run.periodStart)} – ${formatDate(r.run.periodEnd)}`}
          actions={
            <span className="flex items-center gap-2">
              <StatusBadge status={r.run.state} label={label('runState', r.run.state)} />
              {canOpenRuns ? (
                <Link href={runHref(r.run.id)} className="text-[13px] font-medium text-primary hover:underline">
                  Open Run
                </Link>
              ) : null}
            </span>
          }
          bodyClassName="flex flex-col gap-3 p-4"
        >
          <div className="flex flex-wrap gap-6 text-[13px]">
            {r.totals.map((t) => (
              <div key={t.currency} className="flex flex-col gap-0.5">
                <span className="text-fg-2">Payable</span>
                <Money value={t.payable} strong />
                <span className="text-fg-2">
                  Paid <Money value={t.paid} /> · Outstanding <Money value={t.outstanding} />
                </span>
                {!/^0(\.0+)?$/.test(t.carryForward.amount) ? (
                  <span className="text-warning">
                    Carried forward <Money value={t.carryForward} />
                  </span>
                ) : null}
              </div>
            ))}
          </div>
          <RunLinesTable lines={r.lines} caption={`Compensation lines ${r.run.periodStart} – ${r.run.periodEnd}`} />
        </Panel>
      ))}
    </div>
  );
};
