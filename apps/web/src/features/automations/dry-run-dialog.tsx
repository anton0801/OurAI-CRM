'use client';
import { CheckCircle, MinusCircle, XCircle } from '@phosphor-icons/react';
import { keepPreviousData } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { automationEndpoints, type AutomationDryRunResult, type AutomationRuleConfig, type AutomationRuleDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { OPERATOR_LABELS } from '@castlane/domain';
import { Banner, Button, Dialog, Field, Select, formatDateTime } from '@castlane/ui';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { actionLabel, triggerOf, useAutomationCatalog } from './model';

const show = (v: unknown): string => {
  if (v === null || v === undefined) return 'Unknown / empty';
  if (Array.isArray(v)) return v.length ? v.map(show).join(', ') : 'Empty';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
};

/**
 * T139 Dry Run: evaluates the conditions for a sample record and previews each action. It runs in
 * a transaction that is always rolled back — nothing is created and no mail is sent.
 */
export const DryRunDialog = ({ rule, config, open, onOpenChange }: { rule: AutomationRuleDetail; config: AutomationRuleConfig | null; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace, user } = useWorkspace();
  const catalog = useAutomationCatalog();
  const cfg = config ?? rule.currentVersion;
  const t = cfg ? triggerOf(catalog.data, cfg.trigger.event) : undefined;
  const needsSample = !!t && t.kind !== 'schedule';
  const [sample, setSample] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 250);
  const [result, setResult] = useState<AutomationDryRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const params = { workspaceId: workspace.id, ruleId: rule.id };
  const samples = useApiQuery(
    automationEndpoints.dryRunSamples,
    { params, query: { trigger: cfg?.trigger.event, q: q || undefined } },
    { enabled: open && needsSample, placeholderData: keepPreviousData, staleTime: 15_000 },
  );
  useEffect(() => {
    if (open) {
      setResult(null);
      setError(null);
      setSample(null);
      setSearch('');
    }
  }, [open]);
  const m = useApiMutation(automationEndpoints.dryRun, { silentErrors: true });
  const chosen = samples.data?.find((s) => `${s.entityType}:${s.entityId}` === sample);
  const run = () => {
    setError(null);
    void m
      .run({ params, body: { sample: chosen ? { entityType: chosen.entityType, entityId: chosen.entityId } : null, config: config ?? undefined } })
      .then(setResult)
      .catch((e) => setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The dry run could not be completed.'));
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title="Dry Run"
      description={config ? 'Uses the configuration currently in the editor, including unsaved changes.' : `Uses saved version ${rule.currentVersionNo ?? ''}.`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button variant="primary" loading={m.isPending} disabled={needsSample && !chosen} onClick={run}>
            {result ? 'Run Again' : 'Run Dry Run'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Banner tone="info">Nothing is created or changed and no messages are sent: the run is rolled back.</Banner>
        {needsSample ? (
          <Field label="Sample record" required helper="Recent records inside the rule scope that you can open.">
            <Select
              value={sample}
              onChange={setSample}
              onQueryChange={setSearch}
              placeholder={samples.isLoading ? 'Loading…' : 'Choose a record'}
              emptyText="No records in the rule scope yet."
              options={(samples.data ?? []).map((s) => ({ value: `${s.entityType}:${s.entityId}`, label: s.label, description: `${label('entityType', s.entityType)}${s.at ? ` · ${formatDateTime(s.at, user.timezone)}` : ''}` }))}
            />
          </Field>
        ) : (
          <p className="text-[13px] text-fg-2">Scheduled rules have no triggering record; the preview shows what the next slot would do.</p>
        )}
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {result ? (
          <div className="flex flex-col gap-4" aria-live="polite">
            <p className={`flex items-center gap-2 text-[14px] font-medium ${result.matched && !result.blockedReason ? 'text-primary' : 'text-warning'}`}>
              {result.matched && !result.blockedReason ? <CheckCircle size={18} weight="fill" aria-hidden /> : <MinusCircle size={18} weight="fill" aria-hidden />}
              {result.blockedReason ? `Would not run: ${result.blockedReason}` : result.matched ? 'The rule would run for this record.' : 'Conditions do not match — the rule would skip this record.'}
            </p>
            {result.conditions.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-[13px]">
                  <caption className="sr-only">Condition results</caption>
                  <thead className="text-[12px] text-fg-2">
                    <tr className="border-b border-line">
                      <th className="py-2 pr-3 font-[550]">Condition</th>
                      <th className="py-2 pr-3 font-[550]">Expected</th>
                      <th className="py-2 pr-3 font-[550]">Actual</th>
                      <th className="py-2 font-[550]">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.conditions.map((c) => (
                      <tr key={c.index} className="border-b border-line align-top last:border-b-0">
                        <td className="py-2 pr-3">
                          {c.label} <span className="text-fg-2">{OPERATOR_LABELS[c.operator]}</span>
                        </td>
                        <td className="py-2 pr-3 tabular-nums">{show(c.expected)}</td>
                        <td className="py-2 pr-3 tabular-nums">{show(c.actual)}</td>
                        <td className="py-2">
                          <span className={`inline-flex items-center gap-1 ${c.passed ? 'text-primary' : 'text-danger'}`}>
                            {c.passed ? <CheckCircle size={14} weight="fill" aria-hidden /> : <XCircle size={14} weight="fill" aria-hidden />}
                            {c.passed ? 'Matches' : 'No match'}
                          </span>
                          {c.reason ? <span className="block text-[12px] text-fg-2">{c.reason}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <div>
              <p className="mb-2 text-[12px] font-[550] text-fg-2">Actions preview</p>
              <ol className="flex flex-col gap-2">
                {result.actions.map((a) => (
                  <li key={a.index} className="flex gap-2 rounded-[8px] border border-line p-2.5 text-[13px]">
                    <span className="tabular-nums text-fg-muted">{a.index + 1}.</span>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-medium">{actionLabel(catalog.data, a.type)}</span>
                      <span className="break-words text-fg-2">{a.preview}</span>
                      {a.error ? <span className="text-danger">{a.error}</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
};
