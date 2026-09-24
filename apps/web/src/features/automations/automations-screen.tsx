'use client';
import { DotsThree, Lightning, Plus } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { automationEndpoints, type AutomationRuleRow } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { AUTOMATION_STATES } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Button,
  DataTable,
  EmptyState,
  IconButton,
  Input,
  Menu,
  MultiSelect,
  NoResults,
  PageHeader,
  Panel,
  Select,
  StatusBadge,
  Switch,
  Toolbar,
  formatDateTime,
  toast,
  type Column,
  type MenuItem,
} from '@castlane/ui';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { api } from '@/lib/api';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { RULE_STATE_TONE, RUN_STATE_TONE } from './labels';
import { actionLabel, triggerSentence, useAutomationCatalog } from './model';
import { DuplicateDialog } from './rule-screen';

type Filters = 'q' | 'state' | 'trigger' | 'ownerMembershipId' | 'attention' | 'archived';

/** Starter templates with real actions (S64); each opens the editor prefilled, saved disabled. */
const TemplateGallery = ({ compact }: { compact?: boolean }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const catalog = useAutomationCatalog();
  const templates = useApiQuery(automationEndpoints.templates, { params: { workspaceId: workspace.id } }, { staleTime: 5 * 60_000 });
  if (!templates.data?.length) return null;
  return (
    <Panel title="Starter Templates" description="Real rules you can adjust. They are saved disabled until you enable them.">
      <ul className={`grid grid-cols-1 gap-3 md:grid-cols-2 ${compact ? 'xl:grid-cols-3' : 'xl:grid-cols-3'}`}>
        {templates.data.map((t) => (
          <li key={t.key} className="flex flex-col gap-2 rounded-[10px] border border-line p-3">
            <p className="text-[14px] font-medium">{t.name}</p>
            <p className="text-[13px] text-fg-2">{t.description}</p>
            <p className="text-[12px] text-fg-2">
              <span className="font-[550]">When:</span> {triggerSentence(catalog.data, t.config.trigger)}
            </p>
            <p className="text-[12px] text-fg-2">
              <span className="font-[550]">Then:</span> {t.config.actions.map((a) => actionLabel(catalog.data, a.type)).join(' · ')}
            </p>
            <div className="mt-auto pt-1">
              <Link
                href={wsPath(`/automations/new?template=${encodeURIComponent(t.key)}`)}
                className="inline-flex h-11 items-center rounded-[8px] border border-line bg-surface px-[14px] text-[13px] font-semibold text-fg hover:bg-surface-2 md:h-9"
              >
                Use Template
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
};

/** S64 Automations: rules with trigger, scope, state, last run, failures and owner. */
export const AutomationsScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const qc = useQueryClient();
  const catalog = useAutomationCatalog();
  const { state, set, list } = useUrlState<Filters>();
  const [search, setSearch] = useState(state.q ?? '');
  const q = useDebounced(search, 250);
  const [duplicate, setDuplicate] = useState<AutomationRuleRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const query = {
    q: q.length >= 2 ? q : undefined,
    state: list('state') as AutomationRuleRow['state'][],
    trigger: state.trigger as AutomationRuleRow['trigger']['event'] | undefined,
    ownerMembershipId: state.ownerMembershipId,
    needsAttention: state.attention === '1' ? true : undefined,
    includeArchived: state.archived === '1' ? true : undefined,
  };
  const data = useApiInfinite(automationEndpoints.list, { params: { workspaceId: workspace.id }, query });
  const filtered = !!(query.q || query.state.length || query.trigger || query.ownerMembershipId || query.needsAttention);
  const clear = () => {
    setSearch('');
    set({ q: null, state: null, trigger: null, ownerMembershipId: null, attention: null });
  };
  const canCreate = can('automations.create');
  const canEnable = can('automations.enable');
  const refresh = () => qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0] ?? '').startsWith('automations.') });

  const toggle = async (row: AutomationRuleRow, on: boolean) => {
    setBusy(row.id);
    const params = { workspaceId: workspace.id, ruleId: row.id };
    try {
      const detail = await api.call(automationEndpoints.get, { params });
      if (on) {
        if (!detail.currentVersion) throw new Error('The rule has no saved version.');
        await api.call(automationEndpoints.enable, { params, body: { versionId: detail.currentVersion.id } }, { ifMatch: detail.rowVersion });
        toast.success('Rule enabled');
      } else {
        await api.call(automationEndpoints.disable, { params, body: {} }, { ifMatch: detail.rowVersion });
        toast.success('Rule disabled', 'Runs that had not started were cancelled.');
      }
    } catch (e) {
      const msg = isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : e instanceof Error ? e.message : 'The rule could not be changed.';
      toast.error(on ? 'The rule cannot be enabled' : 'The rule could not be disabled', `${msg} Open the rule for details.`);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const columns: Column<AutomationRuleRow>[] = [
    {
      key: 'name',
      header: 'Name',
      sticky: true,
      minWidth: 220,
      cell: (r) => (
        <span className="flex min-w-0 flex-col">
          <Link href={wsPath(`/automations/${r.id}`)} className="truncate font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.name}
          </Link>
          {r.hasUnpublishedChanges ? <span className="text-[12px] text-fg-2">v{r.currentVersionNo} saved, v{r.enabledVersionNo} running</span> : null}
        </span>
      ),
    },
    {
      key: 'trigger',
      header: 'Trigger',
      minWidth: 200,
      cell: (r) => (
        <span className="flex flex-col">
          <span>{r.trigger.label}</span>
          <span className="text-[12px] text-fg-2">
            {label('automationTriggerKind', r.trigger.kind)}
            {r.nextScheduledAt ? ` · next ${formatDateTime(r.nextScheduledAt, user.timezone)}` : ''}
          </span>
        </span>
      ),
    },
    {
      key: 'scope',
      header: 'Scope',
      minWidth: 160,
      cell: (r) => (
        <span className="flex flex-col">
          <span className="truncate">{r.scope.label}</span>
          <span className="text-[12px] text-fg-2">{label('automationScope', r.scope.type)}</span>
        </span>
      ),
    },
    {
      key: 'state',
      header: 'State',
      minWidth: 170,
      cell: (r) => (
        <span className="flex flex-col items-start gap-0.5">
          <StatusBadge status={r.archivedAt ? 'archived' : (RULE_STATE_TONE[r.state] ?? r.state)} label={r.archivedAt ? 'Archived' : label('automationState', r.state)} />
          {r.pausedReason ? (
            <span className="line-clamp-2 text-[12px] text-fg-2" title={r.pausedReason}>
              {r.pausedReason}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'lastRun',
      header: 'Last Run',
      minWidth: 170,
      cell: (r) =>
        r.lastRunAt ? (
          <span className="flex flex-col items-start gap-0.5">
            <span>{formatDateTime(r.lastRunAt, user.timezone)}</span>
            {r.lastRunState ? <StatusBadge status={RUN_STATE_TONE[r.lastRunState] ?? r.lastRunState} label={label('automationRunState', r.lastRunState)} /> : null}
          </span>
        ) : (
          <span className="text-fg-muted">Never run</span>
        ),
    },
    {
      key: 'failures',
      header: 'Failures (7 days)',
      align: 'right',
      minWidth: 130,
      cell: (r) =>
        r.failureCount > 0 ? (
          <Link href={wsPath(`/automations/${r.id}?tab=runs&runState=failed,dead`)} className="font-medium text-danger hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.failureCount}
          </Link>
        ) : (
          <span className="tabular-nums">0</span>
        ),
    },
    {
      key: 'owner',
      header: 'Owner',
      minWidth: 170,
      cell: (r) =>
        r.owner ? (
          <span className="flex items-center gap-2">
            <Avatar name={r.owner.displayName} src={r.owner.avatarUrl} size={24} decorative />
            <span className="truncate">{r.owner.displayName}</span>
          </span>
        ) : (
          <Badge tone="warning">Needs Owner</Badge>
        ),
    },
    {
      key: 'menu',
      header: <span className="sr-only">Actions</span>,
      headerLabel: 'Actions',
      minWidth: 60,
      align: 'center',
      cell: (r) => {
        const items: MenuItem[] = [
          { label: 'Open', href: wsPath(`/automations/${r.id}`) },
          { label: 'Enable', onSelect: () => void toggle(r, true), hidden: !canEnable || !!r.archivedAt || r.state === 'enabled' },
          { label: 'Disable', onSelect: () => void toggle(r, false), hidden: !canEnable || !!r.archivedAt || r.state === 'disabled' || r.state === 'draft' },
          { label: 'View Runs', href: wsPath(`/automations/${r.id}?tab=runs`) },
          { label: 'Duplicate Disabled', onSelect: () => setDuplicate(r), hidden: !canCreate, separatorBefore: true },
        ];
        return (
          <span onClick={(e) => e.stopPropagation()}>
            <Menu label={`Actions for ${r.name}`} trigger={<IconButton label={`Actions for ${r.name}`} icon={<DotsThree size={18} weight="bold" />} variant="ghost" disabled={busy === r.id} />} items={items} />
          </span>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Automations"
        description="Rules that create internal tasks, reminders and notifications. A rule acts only with its owner’s rights inside its scope; there is no code, SQL or webhook."
        actions={
          canCreate ? (
            <Button variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => router.push(wsPath('/automations/new'))}>
              New Rule
            </Button>
          ) : undefined
        }
      />
      <Toolbar>
        <div className="w-full sm:w-[220px]">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              set({ q: e.target.value || null });
            }}
            placeholder="Search rules"
            aria-label="Search rules"
          />
        </div>
        <div className="w-[180px]">
          <MultiSelect aria-label="State" placeholder="State" value={list('state')} onChange={(v) => set({ state: v.join(',') || null })} options={AUTOMATION_STATES.map((s) => ({ value: s, label: label('automationState', s) }))} />
        </div>
        <div className="w-[200px]">
          <Select
            aria-label="Trigger"
            placeholder="Trigger"
            value={state.trigger ?? null}
            onChange={(v) => set({ trigger: v })}
            clearable
            searchable
            options={(catalog.data?.triggers ?? []).map((t) => ({ value: t.key, label: t.label }))}
          />
        </div>
        <div className="w-[180px]">
          <MemberSelect aria-label="Owner" placeholder="Owner" value={state.ownerMembershipId} onChange={(v) => set({ ownerMembershipId: v })} clearable />
        </div>
        <div className="flex items-center gap-4 px-1">
          <Switch label="Needs attention" checked={state.attention === '1'} onCheckedChange={(v) => set({ attention: v ? '1' : null })} />
          <Switch label="Show archived" checked={state.archived === '1'} onCheckedChange={(v) => set({ archived: v ? '1' : null })} />
        </div>
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={clear} />
          ) : (
            <EmptyState
              icon={<Lightning size={28} />}
              title="No automation rules yet"
              description="Start from a template below or create a rule: for example, create a follow-up task when changes are requested on content."
              action={canCreate ? <Button variant="primary" onClick={() => router.push(wsPath('/automations/new'))}>New Rule</Button> : undefined}
            />
          )
        ) : (
          <DataTable
            caption="Automation rules"
            rows={data.items}
            columns={columns}
            getRowId={(r) => r.id}
            density={user.density}
            onRowClick={(r) => router.push(wsPath(`/automations/${r.id}`))}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
      {canCreate ? <TemplateGallery compact={data.items.length > 0} /> : null}
      {duplicate ? <DuplicateDialog rule={duplicate} open onOpenChange={(o) => !o && setDuplicate(null)} onCreated={(id) => router.push(wsPath(`/automations/${id}`))} /> : null}
    </div>
  );
};
