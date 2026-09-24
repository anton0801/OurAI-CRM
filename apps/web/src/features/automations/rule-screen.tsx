'use client';
import { DotsThree, Flask, Power } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { automationEndpoints, type AutomationRuleConfig, type AutomationRuleDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import {
  Avatar,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  Field,
  IconButton,
  Input,
  Menu,
  PageHeader,
  StatusBadge,
  TabPanel,
  Tabs,
  Textarea,
  formatDateTime,
  type Column,
  type MenuItem,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { DryRunDialog } from './dry-run-dialog';
import { RULE_STATE_TONE } from './labels';
import { draftOfRule, triggerSentence, useAutomationCatalog } from './model';
import { RuleEditor } from './rule-editor';
import { RunsPanel } from './runs-panel';

type Version = AutomationRuleDetail['versions'][number];

const errorList = (e: unknown): string[] => (isApiError(e) ? (e.fieldErrors.length ? [...new Set(e.fieldErrors.map((f) => f.message))] : [e.message]) : ['The request failed. Try again.']);

/** S65 Automation Editor / Runs: the rule, its versions and the run timeline. */
export const RuleScreen = ({ ruleId }: { ruleId: string }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(automationEndpoints.get, { params: { workspaceId: workspace.id, ruleId } });
  return <QueryState query={q}>{q.data ? <RuleView rule={q.data} /> : null}</QueryState>;
};

const RuleView = ({ rule: r }: { rule: AutomationRuleDetail }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const catalog = useAutomationCatalog();
  const { state, set } = useUrlState<'tab' | 'run'>({ tab: 'rule' });
  const params = { workspaceId: workspace.id, ruleId: r.id };
  const [dirty, setDirty] = useState(false);
  const [dryRun, setDryRun] = useState<{ config: AutomationRuleConfig | null } | null>(null);
  const [enableErrors, setEnableErrors] = useState<string[] | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [conflict, setConflict] = useState(false);
  const enable = useApiMutation(automationEndpoints.enable, { invalidate: ['automations.'], successMessage: 'Rule enabled', silentErrors: true });
  const onDirtyChange = useCallback((d: boolean) => setDirty(d), []);
  // A pinned run from an alert opens the Runs tab.
  useEffect(() => {
    if (state.run && state.tab !== 'runs') set({ tab: 'runs' });
  }, [state.run, state.tab, set]);
  const initial = useMemo(() => draftOfRule(r), [r]);

  const doEnable = (versionId: string) => {
    setEnableErrors(null);
    void enable.run({ params, body: { versionId } }, { ifMatch: r.rowVersion }).catch((e) => {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else setEnableErrors(errorList(e));
    });
  };

    const archived = !!r.archivedAt;
    const canEnableCurrent = r.permissions.enable && !!r.currentVersion && (r.state !== 'enabled' || r.hasUnpublishedChanges);
    const blockedByDirty = dirty ? 'Save or discard your changes first.' : undefined;
    const menu: MenuItem[] = [
      { label: 'Duplicate Disabled', onSelect: () => setDuplicateOpen(true), hidden: !r.permissions.duplicate },
      { label: archived ? 'Restore as Disabled' : 'Archive', onSelect: () => setArchiveOpen(true), hidden: !r.permissions.archive, destructive: !archived, separatorBefore: true },
    ];
    const versionColumns: Column<Version>[] = [
      { key: 'no', header: 'Version', minWidth: 90, cell: (v) => `v${v.versionNo}` },
      {
        key: 'state',
        header: 'Status',
        minWidth: 160,
        cell: (v) => (
          <span className="flex flex-wrap gap-1.5">
            {v.enabled ? <StatusBadge status="enabled" label={r.state === 'enabled' ? 'Running' : 'Enabled version'} /> : null}
            {v.id === r.currentVersion?.id ? <StatusBadge status="draft" label="Saved (latest)" /> : null}
          </span>
        ),
      },
      { key: 'created', header: 'Saved', minWidth: 170, cell: (v) => formatDateTime(v.createdAt, user.timezone) },
      { key: 'by', header: 'By', minWidth: 160, cell: (v) => v.createdBy?.displayName ?? 'System' },
      {
        key: 'actions',
        header: <span className="sr-only">Actions</span>,
        headerLabel: 'Actions',
        minWidth: 150,
        align: 'right',
        cell: (v) =>
          r.permissions.enable && !(v.enabled && r.state === 'enabled') ? (
            <Button size="sm" disabled={!!blockedByDirty} loading={enable.isPending} onClick={() => doEnable(v.id)}>
              Enable v{v.versionNo}
            </Button>
          ) : null,
      },
    ];
    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          crumbs={[{ label: 'Automations', href: wsPath('/automations') }, { label: r.name }]}
          title={r.name}
          meta={
            <>
              <StatusBadge status={RULE_STATE_TONE[r.state] ?? r.state} label={archived ? 'Archived' : label('automationState', r.state)} />
              <span className="text-[13px] text-fg-2">{r.currentVersion ? triggerSentence(catalog.data, r.currentVersion.trigger) : r.trigger.label}</span>
              <span className="text-[13px] text-fg-2">
                {label('automationScope', r.scope.type)}: {r.scope.label}
              </span>
              {r.owner ? (
                <span className="flex items-center gap-1.5 text-[13px] text-fg-2">
                  <Avatar name={r.owner.displayName} src={r.owner.avatarUrl} size={24} decorative /> {r.owner.displayName}
                </span>
              ) : (
                <StatusBadge status="paused" label="Needs Owner" />
              )}
              <span className="text-[13px] text-fg-2">
                Version {r.currentVersionNo ?? '—'}
                {r.enabledVersionNo && r.enabledVersionNo !== r.currentVersionNo ? ` (running v${r.enabledVersionNo})` : ''}
              </span>
            </>
          }
          actions={
            <>
              {r.permissions.dryRun && r.currentVersion ? (
                <Button icon={<Flask size={14} />} onClick={() => setDryRun({ config: null })}>
                  Dry Run
                </Button>
              ) : null}
              {r.permissions.disable ? (
                <Button icon={<Power size={14} />} disabled={!!blockedByDirty} title={blockedByDirty} onClick={() => setDisableOpen(true)}>
                  Disable
                </Button>
              ) : null}
              {canEnableCurrent ? (
                <Button variant="primary" loading={enable.isPending} disabled={!!blockedByDirty} title={blockedByDirty} onClick={() => doEnable(r.currentVersion!.id)}>
                  {r.hasUnpublishedChanges ? `Enable v${r.currentVersionNo}` : 'Enable'}
                </Button>
              ) : null}
              {menu.some((m) => !m.hidden) ? <Menu label="More actions" trigger={<IconButton label="More actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={menu} /> : null}
            </>
          }
        />
        {archived ? <Banner tone="info">This rule is archived: it does not run and its history is kept. Restore it as disabled to use it again.</Banner> : null}
        {r.state === 'paused_needs_owner' ? <Banner tone="warning">Needs Owner: the rule is paused because it has no active owner. Assign an owner and enable it again.</Banner> : null}
        {r.state === 'paused_requires_attention' ? (
          <Banner tone="warning">Paused — Requires Attention{r.pausedReason ? `: ${r.pausedReason}` : '.'} Nothing runs until the owner or scope is fixed and the rule is enabled again.</Banner>
        ) : null}
        {r.hasUnpublishedChanges ? (
          <Banner tone="info">
            Version {r.currentVersionNo} is saved but not enabled; the rule keeps running version {r.enabledVersionNo}.
          </Banner>
        ) : null}
        {enableErrors ? (
          <Banner tone="danger">
            <span className="flex flex-col gap-1">
              <span className="font-medium">The rule cannot be enabled:</span>
              {enableErrors.map((m) => (
                <span key={m}>{m}</span>
              ))}
            </span>
          </Banner>
        ) : null}
        <Tabs
          label="Rule sections"
          value={state.tab ?? 'rule'}
          onValueChange={(v) => set({ tab: v, run: v === 'runs' ? state.run : null })}
          items={[
            { value: 'rule', label: 'Rule' },
            { value: 'runs', label: 'Runs', count: r.runCounts.failed || undefined },
            { value: 'versions', label: 'Versions', count: r.versions.length },
          ]}
        >
          <TabPanel value="rule">
            {state.tab === 'rule' || !state.tab ? (
              <RuleEditor
                key={r.id}
                initial={initial}
                rule={r}
                readOnly={!r.permissions.edit}
                onDirtyChange={onDirtyChange}
                onDryRun={r.permissions.dryRun && r.permissions.edit ? (config) => setDryRun({ config }) : undefined}
              />
            ) : null}
          </TabPanel>
          <TabPanel value="runs">{state.tab === 'runs' ? <RunsPanel rule={r} /> : null}</TabPanel>
          <TabPanel value="versions">
            {state.tab === 'versions' ? <DataTable caption="Rule versions" rows={r.versions} columns={versionColumns} getRowId={(v) => v.id} density={user.density} /> : null}
          </TabPanel>
        </Tabs>
        {dryRun ? <DryRunDialog rule={r} config={dryRun.config} open onOpenChange={(o) => !o && setDryRun(null)} /> : null}
        <DisableDialog rule={r} open={disableOpen} onOpenChange={setDisableOpen} onConflict={() => setConflict(true)} />
        <DuplicateDialog rule={r} open={duplicateOpen} onOpenChange={setDuplicateOpen} onCreated={(id) => router.push(wsPath(`/automations/${id}`))} />
        <ArchiveRuleDialog rule={r} open={archiveOpen} onOpenChange={setArchiveOpen} onConflict={() => setConflict(true)} />
        <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
      </div>
  );
};

const DisableDialog = ({ rule, open, onOpenChange, onConflict }: { rule: AutomationRuleDetail; open: boolean; onOpenChange: (o: boolean) => void; onConflict: () => void }) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const m = useApiMutation(automationEndpoints.disable, { invalidate: ['automations.'], successMessage: 'Rule disabled' });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Disable Rule"
      body={`Runs that have not started yet${rule.runCounts.pending ? ` (${rule.runCounts.pending} waiting)` : ''} are cancelled. Actions already completed stay as they are.`}
      confirmLabel="Disable"
      destructive
      loading={m.isPending}
      onConfirm={() =>
        void m
          .run({ params: { workspaceId: workspace.id, ruleId: rule.id }, body: { reason: reason.trim() || undefined } }, { ifMatch: rule.rowVersion })
          .then(() => onOpenChange(false))
          .catch((e) => {
            onOpenChange(false);
            if (isApiError(e) && e.code === 'VERSION_CONFLICT') onConflict();
          })
      }
    >
      <Field label="Reason" helper="Optional; recorded in the audit log.">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
      </Field>
    </ConfirmDialog>
  );
};

export const DuplicateDialog = ({ rule, open, onOpenChange, onCreated }: { rule: { id: string; name: string }; open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) => {
  const { workspace } = useWorkspace();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(`${rule.name} (copy)`.slice(0, 120));
      setError(null);
    }
    // Only when the dialog opens: a live rename of the rule must not replace the typed name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const m = useApiMutation(automationEndpoints.duplicate, { invalidate: ['automations.'], successMessage: 'Copy saved as disabled', silentErrors: true });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title="Duplicate Disabled"
      description="Copies the latest saved version into a new rule that starts disabled."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            disabled={name.trim().length < 2}
            onClick={() =>
              void m
                .run({ params: { workspaceId: workspace.id, ruleId: rule.id }, body: { name: name.trim() } })
                .then((r) => {
                  onOpenChange(false);
                  onCreated(r.id);
                })
                .catch((e) => setError(isApiError(e) ? e.message : 'The rule could not be duplicated.'))
            }
          >
            Duplicate
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
      </div>
    </Dialog>
  );
};

const ArchiveRuleDialog = ({ rule, open, onOpenChange, onConflict }: { rule: AutomationRuleDetail; open: boolean; onOpenChange: (o: boolean) => void; onConflict: () => void }) => {
  const { workspace } = useWorkspace();
  const restore = !!rule.archivedAt;
  const m = useApiMutation(automationEndpoints.archive, { invalidate: ['automations.'], successMessage: restore ? 'Rule restored as disabled' : 'Rule archived' });
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={restore ? 'Restore Rule' : 'Archive Rule'}
      body={restore ? 'The rule comes back disabled with all versions and runs.' : 'The rule is disabled, runs that have not started are cancelled, and it leaves the list. Versions and runs are kept.'}
      confirmLabel={restore ? 'Restore' : 'Archive'}
      destructive={!restore}
      loading={m.isPending}
      onConfirm={() =>
        void m
          .run({ params: { workspaceId: workspace.id, ruleId: rule.id }, body: { restore: restore || undefined } }, { ifMatch: rule.rowVersion })
          .then(() => onOpenChange(false))
          .catch((e) => {
            onOpenChange(false);
            if (isApiError(e) && e.code === 'VERSION_CONFLICT') onConflict();
          })
      }
    />
  );
};
