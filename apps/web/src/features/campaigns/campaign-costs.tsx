'use client';
import { Receipt } from '@phosphor-icons/react';
import { useState } from 'react';
import { campaignEndpoints as C, type CampaignCostLine, type CampaignDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { AmountInput, Badge, Banner, Button, Checkbox, DataTable, DescriptionList, Dialog, EmptyState, Field, Input, Panel, RadioGroup, Textarea, formatDate, formatMoney, type Column } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';
import { CAMPAIGN_INVALIDATE } from './labels';

/**
 * S34 Costs: expense lines attributed to the campaign through finance allocations. Each allocation
 * is counted once; tags never add costs. Budgets are contributed by the finance module (CAMPAIGN_TABS).
 */
export const CampaignCostsTab = ({ campaign: c }: { campaign: CampaignDetail }) => {
  const { workspace, user } = useWorkspace();
  const q = useApiQuery(C.costs, { params: { workspaceId: workspace.id, campaignId: c.id } });
  const [allocating, setAllocating] = useState<CampaignCostLine | null>(null);
  const columns: Column<CampaignCostLine>[] = [
    {
      key: 'entry',
      header: 'Entry',
      sticky: true,
      minWidth: 220,
      cell: (l) => (
        <span className="flex flex-col">
          <span className="font-medium text-fg">{l.entryTitle}</span>
          <span className="text-[12px] text-fg-2">
            {l.category} · {formatDate(l.recognitionDate)}
          </span>
        </span>
      ),
    },
    { key: 'state', header: 'State', minWidth: 110, cell: (l) => <Badge tone={l.entryState === 'posted' ? 'success' : 'neutral'}>{l.entryState === 'posted' ? 'Posted' : 'Pending'}</Badge> },
    { key: 'amount', header: 'Line amount', align: 'right', minWidth: 130, cell: (l) => formatMoney(l.amount.amount, l.amount.currency) },
    { key: 'campaign', header: 'This campaign', align: 'right', minWidth: 130, cell: (l) => formatMoney(l.campaignAmount.amount, l.campaignAmount.currency) },
    {
      key: 'split',
      header: 'Allocation',
      minWidth: 260,
      cell: (l) =>
        l.allocations.length ? (
          <ul className="flex flex-col gap-0.5 text-[13px]">
            {l.allocations.map((a) => (
              <li key={a.id}>
                {a.project?.name ?? 'No project'}: {formatMoney(a.amount.amount, a.amount.currency)}
                {a.sharePercent ? <span className="text-fg-2"> ({a.sharePercent}%)</span> : null}
              </li>
            ))}
            {l.unallocated && Number(l.unallocated.amount) !== 0 ? <li className="text-warning">Unallocated: {formatMoney(l.unallocated.amount, l.unallocated.currency)}</li> : null}
          </ul>
        ) : (
          <span className="text-warning">Not allocated to projects yet</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      minWidth: 100,
      cell: (l) =>
        l.canAllocate ? (
          <Button size="sm" variant="ghost" onClick={() => setAllocating(l)}>
            {l.allocations.length ? 'Reallocate' : 'Allocate'}
          </Button>
        ) : null,
    },
  ];
  return (
    <QueryState query={q}>
      {q.data ? (
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-fg-2">{q.data.note}</p>
          {q.data.incompleteAllocation ? <Banner tone="warning">Some expense lines are not fully allocated to the campaign’s projects. Project totals exclude the unallocated part.</Banner> : null}
          <Panel title="Totals">
            {q.data.totals.length ? (
              <DescriptionList
                columns={3}
                items={q.data.totals.flatMap((t) => [
                  { label: `Posted (${t.currency})`, value: formatMoney(t.posted, t.currency) },
                  { label: `Pending (${t.currency})`, value: formatMoney(t.pending, t.currency) },
                ])}
              />
            ) : (
              <p className="text-[14px] text-fg-2">No costs are linked to this campaign.</p>
            )}
          </Panel>
          {q.data.lines.length ? (
            <DataTable caption="Campaign cost lines" rows={q.data.lines} columns={columns} getRowId={(l) => l.lineId} density={user.density} />
          ) : (
            <EmptyState icon={<Receipt size={28} />} title="No campaign costs" description="Link expense entries to this campaign in Finance; they appear here with their project allocation." />
          )}
          {allocating ? <AllocateDialog campaign={c} line={allocating} onClose={() => setAllocating(null)} /> : null}
        </div>
      ) : null}
    </QueryState>
  );
};

type Method = 'equal' | 'weights' | 'amounts';

/** Split one expense line across the campaign's projects; the server conserves minor units exactly. */
const AllocateDialog = ({ campaign: c, line, onClose }: { campaign: CampaignDetail; line: CampaignCostLine; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [method, setMethod] = useState<Method>('equal');
  const [selected, setSelected] = useState<string[]>(line.allocations.length ? line.allocations.map((a) => a.project?.id).filter((x): x is string => !!x) : c.projects.map((p) => p.id));
  const [weights, setWeights] = useState<Record<string, string>>(Object.fromEntries(c.projects.map((p) => [p.id, '1'])));
  const [amounts, setAmounts] = useState<Record<string, string>>(Object.fromEntries(line.allocations.filter((a) => a.project).map((a) => [a.project!.id, a.amount.amount])));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useApiMutation(C.allocateCost, { invalidate: CAMPAIGN_INVALIDATE, silentErrors: true, successMessage: 'Cost allocated' });
  const posted = line.entryState === 'posted';
  const submit = async () => {
    setError(null);
    if (!selected.length) {
      setError('Choose at least one project.');
      return;
    }
    if (posted && line.allocations.length && reason.trim().length < 3) {
      setError('Give a reason for changing the allocation of a posted entry.');
      return;
    }
    const shares = selected.map((projectId) => ({
      projectId,
      ...(method === 'weights' ? { weight: (weights[projectId] ?? '').trim() } : {}),
      ...(method === 'amounts' ? { amount: (amounts[projectId] ?? '').trim() } : {}),
    }));
    try {
      await m.run({ params: { workspaceId: workspace.id, campaignId: c.id }, body: { lineId: line.lineId, method, shares, ...(reason.trim().length >= 3 ? { reason: reason.trim() } : {}) } });
      onClose();
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The allocation could not be saved.');
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Allocate cost"
      description={`${line.entryTitle}: ${formatMoney(line.amount.amount, line.amount.currency)}. The parts always add up exactly to the line amount.`}
      footer={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} onClick={() => void submit()}>
            Save Allocation
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <RadioGroup
          label="Split"
          orientation="horizontal"
          value={method}
          onValueChange={(v) => setMethod(v as Method)}
          options={[
            { value: 'equal', label: 'Equally' },
            { value: 'weights', label: 'By weight' },
            { value: 'amounts', label: 'Exact amounts' },
          ]}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[14px] font-medium text-fg">Projects</legend>
          {c.projects.map((p) => {
            const on = selected.includes(p.id);
            return (
              <div key={p.id} className="grid grid-cols-[1fr_160px] items-center gap-3">
                <Checkbox label={p.name} checked={on} onCheckedChange={(v) => setSelected(v ? [...selected, p.id] : selected.filter((x) => x !== p.id))} />
                {on && method === 'weights' ? (
                  <Field label={`Weight for ${p.name}`} hideLabel>
                    <Input value={weights[p.id] ?? ''} onChange={(e) => setWeights({ ...weights, [p.id]: e.target.value })} inputMode="decimal" />
                  </Field>
                ) : on && method === 'amounts' ? (
                  <Field label={`Amount for ${p.name}`} hideLabel>
                    <AmountInput value={amounts[p.id] ?? ''} onChange={(e) => setAmounts({ ...amounts, [p.id]: e.target.value })} currency={line.amount.currency} />
                  </Field>
                ) : (
                  <span />
                )}
              </div>
            );
          })}
        </fieldset>
        {posted ? <p className="text-[13px] text-fg-2">This entry is posted: the current allocation is kept in history and the new one is recorded as an adjustment.</p> : null}
        <Field label="Reason" required={posted && line.allocations.length > 0} helper="Recorded in the finance history.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={2000} />
        </Field>
      </div>
    </Dialog>
  );
};
