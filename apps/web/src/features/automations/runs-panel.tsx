'use client';
import { ArrowClockwise, ArrowSquareOut, CheckCircle, MinusCircle, XCircle } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { automationEndpoints, type AutomationRuleDetail, type AutomationRunRow } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { AUTOMATION_RUN_STATES } from '@castlane/domain';
import { Banner, Button, Dialog, EmptyState, Field, MultiSelect, NoResults, StatusBadge, Textarea, Toolbar, formatDateTime } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace } from '@/lib/workspace-context';
import { RUN_STATE_TONE } from './labels';
import { actionLabel, triggerOf, useAutomationCatalog } from './model';

const Mono = ({ children, title }: { children: string; title?: string }) => (
  <code className="break-all rounded-[4px] bg-surface-2 px-1 py-0.5 font-mono text-[12px]" title={title}>
    {children}
  </code>
);

/** One run in the timeline: event ids, record, errors and per-action results with links. */
const RunItem = ({ run, canRetry, onRetry, highlighted }: { run: AutomationRunRow; canRetry: boolean; onRetry: (r: AutomationRunRow) => void; highlighted?: boolean }) => {
  const { user } = useWorkspace();
  const catalog = useAutomationCatalog();
  const trig = run.triggerEvent ? triggerOf(catalog.data, run.triggerEvent) : undefined;
  return (
    <li className={`relative flex gap-3 pb-5 pl-6 last:pb-0 ${highlighted ? 'rounded-[10px] bg-selection/40 p-2' : ''}`}>
      <span aria-hidden className="absolute left-[7px] top-2 h-full w-px bg-line" />
      <span aria-hidden className={`absolute left-[3px] top-1.5 h-[9px] w-[9px] rounded-full ${run.state === 'succeeded' ? 'bg-primary' : run.state === 'failed' || run.state === 'dead' ? 'bg-danger' : 'bg-fg-muted'}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={RUN_STATE_TONE[run.state] ?? run.state} label={label('automationRunState', run.state)} />
          <span className="text-[13px] font-medium">{trig?.label ?? (run.triggerEvent ? label('automationTrigger', run.triggerEvent) : 'Run')}</span>
          <span className="text-[12px] text-fg-2">{formatDateTime(run.finishedAt ?? run.startedAt ?? run.createdAt, user.timezone)}</span>
          {run.versionNo !== null ? <span className="text-[12px] text-fg-2">Version {run.versionNo}</span> : null}
          {run.attempts > 1 ? <span className="text-[12px] text-fg-2">{run.attempts} attempts</span> : null}
          {run.depth > 0 ? <span className="text-[12px] text-fg-2">Chain depth {run.depth}</span> : null}
          {run.canRetry && canRetry ? (
            <Button size="sm" icon={<ArrowClockwise size={12} />} className="ml-auto" onClick={() => onRetry(run)}>
              Retry Failed Run
            </Button>
          ) : null}
        </div>
        {run.record ? (
          <p className="text-[13px]">
            Record:{' '}
            {run.record.href ? (
              <Link href={run.record.href} className="text-primary hover:underline">
                {run.record.label ?? label('entityType', run.record.entityType)}
              </Link>
            ) : (
              <span className="text-fg-2">{run.record.label ?? 'Record you cannot open'}</span>
            )}
          </p>
        ) : null}
        {run.state === 'throttled' && run.notBefore ? <p className="text-[13px] text-warning">Delayed by the rule’s rate limit until {formatDateTime(run.notBefore, user.timezone)}; it is not dropped.</p> : null}
        {run.errorMessage ? (
          <p className="text-[13px] text-danger">
            {run.errorCode ? <Mono>{run.errorCode}</Mono> : null} {run.errorMessage}
          </p>
        ) : null}
        {run.actionResults.length ? (
          <ol className="flex flex-col gap-1 text-[13px]">
            {run.actionResults.map((a) => (
              <li key={a.index} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {a.skipped ? (
                  <MinusCircle size={14} weight="fill" className="text-fg-muted" aria-label="Skipped" />
                ) : a.ok ? (
                  <CheckCircle size={14} weight="fill" className="text-primary" aria-label="Done" />
                ) : (
                  <XCircle size={14} weight="fill" className="text-danger" aria-label="Failed" />
                )}
                <span>
                  {a.index + 1}. {actionLabel(catalog.data, a.type)}
                </span>
                {a.note ? <span className="text-fg-2">— {a.note}</span> : null}
                {a.error ? <span className="text-danger">— {a.error}</span> : null}
                {a.href ? (
                  <Link href={a.href} className="inline-flex items-center gap-1 text-primary hover:underline">
                    Open Created Object <ArrowSquareOut size={12} aria-hidden />
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        ) : null}
        <details className="text-[12px] text-fg-2">
          <summary className="cursor-pointer select-none">Event and operation ids</summary>
          <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt>Event</dt>
            <dd>
              <Mono>{run.eventId}</Mono>
            </dd>
            <dt>Root event</dt>
            <dd>
              <Mono>{run.rootEventId}</Mono>
            </dd>
            <dt>Operation key</dt>
            <dd>
              <Mono title="Retries reuse this key, so completed effects are not repeated.">{run.operationKey}</Mono>
            </dd>
            <dt>Run</dt>
            <dd>
              <Mono>{run.id}</Mono>
            </dd>
          </dl>
        </details>
      </div>
    </li>
  );
};

const RetryDialog = ({ run, onOpenChange }: { run: AutomationRunRow | null; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (run) {
      setReason('');
      setError(null);
    }
  }, [run]);
  const m = useApiMutation(automationEndpoints.retryRun, { invalidate: ['automations.'], successMessage: 'Retry queued with the same operation key', silentErrors: true });
  return (
    <>
      <Dialog
        open={!!run}
        onOpenChange={onOpenChange}
        title="Retry Failed Run"
        description="The run is queued again with its original operation key: actions that already succeeded are not repeated, and the owner’s access is checked again."
        footer={
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={m.isPending}
              disabled={reason.trim().length < 3}
              onClick={() =>
                run &&
                void m
                  .run({ params: { workspaceId: workspace.id, runId: run.id }, body: { reason: reason.trim() } }, { ifMatch: run.rowVersion })
                  .then(() => onOpenChange(false))
                  .catch((e) => {
                    if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
                    else setError(isApiError(e) ? e.message : 'The run could not be retried.');
                  })
              }
            >
              Retry Run
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {run?.errorMessage ? <p className="text-[13px] text-fg-2">Last error: {run.errorMessage}</p> : null}
          <Field label="Reason" required helper="Recorded in the audit log. At least 3 characters.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </>
  );
};

/** S65 run timeline, newest first. `?run=<id>` pins one run (links from alerts and Inbox). */
export const RunsPanel = ({ rule }: { rule: AutomationRuleDetail }) => {
  const { workspace } = useWorkspace();
  const { state, set, list } = useUrlState<'runState' | 'run'>();
  const [retry, setRetry] = useState<AutomationRunRow | null>(null);
  const query = { state: list('runState') as AutomationRunRow['state'][] };
  const data = useApiInfinite(automationEndpoints.runs, { params: { workspaceId: workspace.id, ruleId: rule.id }, query });
  const pinned = useApiQuery(automationEndpoints.run, { params: { workspaceId: workspace.id, runId: state.run ?? '' } }, { enabled: !!state.run });
  const canRetry = rule.permissions.retry;
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-[220px]">
          <MultiSelect
            aria-label="Run status"
            placeholder="Run status"
            value={list('runState')}
            onChange={(v) => set({ runState: v.join(',') || null })}
            options={AUTOMATION_RUN_STATES.map((s) => ({ value: s, label: label('automationRunState', s) }))}
          />
        </div>
        <p className="text-[13px] text-fg-2">
          {rule.runCounts.succeeded} succeeded · {rule.runCounts.failed} failed · {rule.runCounts.skipped} skipped · {rule.runCounts.pending} waiting
        </p>
      </Toolbar>
      {state.run && pinned.data ? (
        <div className="rounded-[12px] border border-line bg-surface p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[12px] font-[550] text-fg-2">Linked run</p>
            <Button size="sm" variant="ghost" onClick={() => set({ run: null })}>
              Show all runs
            </Button>
          </div>
          <ol>
            <RunItem run={pinned.data} canRetry={canRetry} onRetry={setRetry} highlighted />
          </ol>
        </div>
      ) : null}
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          query.state.length ? (
            <NoResults onClear={() => set({ runState: null })} />
          ) : (
            <EmptyState title="No runs yet" description={rule.state === 'enabled' ? 'Runs appear here when the trigger fires inside the rule scope.' : 'Enable the rule to start running it. Dry Run shows what it would do without running it.'} />
          )
        ) : (
          <div className="rounded-[12px] border border-line bg-surface p-4">
            <ol aria-label="Run timeline">
              {data.items.map((r) => (
                <RunItem key={r.id} run={r} canRetry={canRetry} onRetry={setRetry} />
              ))}
            </ol>
            {data.hasNextPage ? (
              <div className="mt-4 flex justify-center">
                <Button loading={data.isFetchingNextPage} onClick={() => void data.fetchNextPage()}>
                  Load More
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </QueryState>
      <RetryDialog run={retry} onOpenChange={(o) => !o && setRetry(null)} />
    </div>
  );
};
