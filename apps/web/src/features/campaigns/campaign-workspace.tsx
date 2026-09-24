'use client';
import { DotsThree, PencilSimple, Plus } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { campaignEndpoints as C, publicationEndpoints as P, type CampaignDetail } from '@castlane/api-contracts';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DescriptionList,
  IconButton,
  Menu,
  PageHeader,
  Panel,
  StatusBadge,
  TabPanel,
  Tabs,
  formatDate,
  formatDateTime,
  formatMoney,
  type MenuItem,
} from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { CAMPAIGN_TABS } from '@/lib/slots';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import '@/features/slots';
import { PublicationTable } from '@/features/publications/publication-list';
import { ARCHIVE_EXPLANATION } from '@/features/publications/labels';
import { ArchiveCampaignDialog, DuplicateCampaignDialog, LinkDealDialog, TransitionCampaignDialog } from './campaign-dialogs';
import { CampaignCostsTab } from './campaign-costs';
import { CampaignFormDrawer } from './campaign-form';
import { CampaignLinksTab } from './campaign-links';
import { CampaignResultsTab } from './campaign-results';
import { CAMPAIGN_INVALIDATE } from './labels';

type DialogKind = 'edit' | 'duplicate' | 'linkDeal' | 'archive' | 'restore' | null;

/** S34 Campaign Workspace: objective, placements, tagged links, reported results, costs and history. */
export const CampaignWorkspace = ({ campaignId }: { campaignId: string }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(C.get, { params: { workspaceId: workspace.id, campaignId } });
  return <QueryState query={q}>{q.data ? <CampaignView c={q.data} /> : null}</QueryState>;
};

const CampaignView = ({ c }: { c: CampaignDetail }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const can = useCan();
  const { state, set } = useUrlState<'tab'>({ tab: 'overview' });
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [target, setTarget] = useState<CampaignDetail['status'] | null>(null);
  const restore = useApiMutation(C.restore, { invalidate: CAMPAIGN_INVALIDATE, successMessage: 'Campaign restored as Closed' });
  const archived = c.status === 'archived';
  const slotProps = { campaignId: c.id };
  const extraTabs = CAMPAIGN_TABS.items.filter((t) => !t.visible || t.visible(slotProps, can));
  const tabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'deliverables', label: 'Deliverables' },
    { key: 'links', label: 'Links' },
    { key: 'results', label: 'Results' },
    ...(c.permissions.readCosts ? [{ key: 'costs', label: 'Costs' }] : []),
    ...extraTabs.map((t) => ({ key: t.key, label: t.label })),
    { key: 'activity', label: 'Activity' },
  ];
  const active = tabs.find((t) => t.key === state.tab)?.key ?? 'overview';
  const addDeliverable = wsPath(`/publications/new?campaignId=${c.id}${c.projects.length === 1 ? `&projectId=${c.projects[0]!.id}` : ''}`);

  const transitionLabel = (t: CampaignDetail['status']) => (t === 'active' ? (c.status === 'closed' ? 'Reopen' : 'Start Campaign') : t === 'closed' ? (archived ? 'Restore' : 'Close Campaign') : t);
  const menu: MenuItem[] = [
    ...(!archived ? c.allowedTransitions.map((t) => ({ label: transitionLabel(t), onSelect: () => setTarget(t) })) : []),
    { label: 'Link Deal', hidden: !c.permissions.linkDeal || archived, separatorBefore: true, onSelect: () => setDialog('linkDeal') },
    { label: 'Add Deliverable', hidden: !c.permissions.createPublication || archived, href: addDeliverable },
    { label: 'Duplicate Structure', hidden: !can('campaigns.write'), onSelect: () => setDialog('duplicate') },
    { label: 'Restore', hidden: !archived || !c.permissions.archive, separatorBefore: true, onSelect: () => setDialog('restore') },
    { label: 'Archive', hidden: archived || !c.permissions.archive || !['planned', 'closed'].includes(c.status), destructive: true, separatorBefore: true, onSelect: () => setDialog('archive') },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Campaigns', href: wsPath('/campaigns') }, { label: c.name }]}
        title={c.name}
        description={c.objective}
        meta={
          <>
            <StatusBadge status={c.status} label={label('campaignStatus', c.status)} />
            <span className="text-[13px] text-fg-2">
              {formatDate(c.startDate)} – {formatDate(c.endDate)}
            </span>
            <span className="flex items-center gap-1.5 text-[13px] text-fg-2">
              <Avatar name={c.owner.displayName} src={c.owner.avatarUrl} size={24} decorative /> {c.owner.displayName}
            </span>
            {c.projects.map((p) => (
              <Link key={p.id} href={wsPath(`/projects/${p.id}`)} className="text-[13px] text-fg-2 hover:underline">
                {p.name}
              </Link>
            ))}
            {c.tags.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
          </>
        }
        actions={
          <>
            {c.permissions.createPublication && !archived ? (
              <Button icon={<Plus size={14} />} onClick={() => router.push(addDeliverable)}>
                Add Deliverable
              </Button>
            ) : null}
            {c.permissions.update && !archived ? (
              <Button icon={<PencilSimple size={14} />} onClick={() => setDialog('edit')}>
                Edit
              </Button>
            ) : null}
            {menu.some((m) => !m.hidden) ? <Menu label="More actions" trigger={<IconButton label="More actions" icon={<DotsThree size={18} weight="bold" />} variant="secondary" />} items={menu} /> : null}
          </>
        }
      />
      {archived ? <Banner tone="info">{ARCHIVE_EXPLANATION}</Banner> : null}
      {c.status === 'closed' && c.closingSummary ? <Banner tone="info">Closed{c.closedAt ? ` ${formatDate(c.closedAt)}` : ''}: {c.closingSummary}</Banner> : null}
      <Tabs label="Campaign sections" value={active} onValueChange={(v) => set({ tab: v })} items={tabs.map((t) => ({ value: t.key, label: t.label }))}>
        <TabPanel value="overview">{active === 'overview' ? <Overview c={c} /> : null}</TabPanel>
        <TabPanel value="deliverables">
          {active === 'deliverables' ? (
            <PublicationTable
              filters={{ campaignId: c.id }}
              caption="Campaign placements"
              emptyTitle="No deliverables yet"
              emptyText="Placements whose primary campaign is this campaign appear here. A campaign never publishes content or creates accounts."
              newHref={c.permissions.createPublication && !archived ? addDeliverable : null}
            />
          ) : null}
        </TabPanel>
        <TabPanel value="links">{active === 'links' ? <CampaignLinksTab campaign={c} /> : null}</TabPanel>
        <TabPanel value="results">{active === 'results' ? <CampaignResultsTab campaign={c} /> : null}</TabPanel>
        {c.permissions.readCosts ? <TabPanel value="costs">{active === 'costs' ? <CampaignCostsTab campaign={c} /> : null}</TabPanel> : null}
        {extraTabs.map((t) => (
          <TabPanel key={t.key} value={t.key}>
            {active === t.key ? <t.component {...slotProps} /> : null}
          </TabPanel>
        ))}
        <TabPanel value="activity">{active === 'activity' ? <Activity id={c.id} /> : null}</TabPanel>
      </Tabs>
      {dialog === 'edit' ? <CampaignFormDrawer open campaign={c} onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog === 'duplicate' ? <DuplicateCampaignDialog campaign={c} open onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog === 'linkDeal' ? <LinkDealDialog campaign={c} open onOpenChange={(o) => !o && setDialog(null)} /> : null}
      {dialog === 'archive' ? <ArchiveCampaignDialog campaign={c} open onOpenChange={(o) => !o && setDialog(null)} /> : null}
      <TransitionCampaignDialog campaign={c} target={target} onClose={() => setTarget(null)} />
      <ConfirmDialog
        open={dialog === 'restore'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Restore campaign?"
        body="The campaign returns as Closed. Reopen it afterwards to continue work."
        confirmLabel="Restore"
        loading={restore.isPending}
        onConfirm={async () => {
          try {
            await restore.run({ params: { workspaceId: workspace.id, campaignId: c.id } }, { ifMatch: c.rowVersion });
            setDialog(null);
          } catch {
            /* error toast shown by the mutation */
          }
        }}
      />
    </div>
  );
};

const Overview = ({ c }: { c: CampaignDetail }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  // Up to 6 previews of placements (80×100); images only from records.
  const previews = useApiQuery(P.list, { params: { workspaceId: workspace.id }, query: { campaignId: c.id, sort: 'when', direction: 'desc', pageSize: 6 } });
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Panel title="Campaign" className="lg:col-span-2">
        <DescriptionList
          items={[
            { label: 'Objective', value: c.objective },
            { label: 'Dates', value: `${formatDate(c.startDate)} – ${formatDate(c.endDate)}` },
            { label: 'Owner', value: c.owner.displayName },
            { label: 'Projects', value: c.projects.map((p) => p.name).join(', ') },
            { label: 'Partner', value: c.partner?.name ?? null },
            { label: 'Budget', value: c.budget ? `${formatMoney(c.budget.planned.amount, c.budget.planned.currency)} (${formatDate(c.budget.periodStart)} – ${formatDate(c.budget.periodEnd)})` : null, hidden: c.budget === undefined },
            { label: 'Duplicated from', value: c.duplicatedFrom ? <Link href={wsPath(`/campaigns/${c.duplicatedFrom.id}`)} className="hover:underline">{c.duplicatedFrom.name}</Link> : null, hidden: !c.duplicatedFrom },
            { label: 'Closing summary', value: c.closingSummary, hidden: !c.closingSummary },
            { label: 'Updated', value: formatDateTime(c.updatedAt, user.timezone) },
          ]}
        />
      </Panel>
      <Panel title="At a glance">
        <DescriptionList
          columns={1}
          items={[
            { label: 'Planned / Published', value: `${c.publications.planned} / ${c.publications.published}` },
            { label: 'Tagged links', value: c.counts.trackingLinks },
            { label: 'Source reports', value: c.counts.sourceReports },
            { label: 'Experiments', value: c.counts.experiments },
            {
              label: 'Confirmed results',
              value: c.confirmedResults.reports ? `${c.confirmedResults.clicks ?? '—'} clicks · ${c.confirmedResults.conversions ?? '—'} conversions` : <span className="text-fg-muted">No source reports</span>,
            },
          ]}
        />
      </Panel>
      <Panel title="Goals" className="lg:col-span-2">
        {c.goals.length ? (
          <ul className="flex flex-col gap-2">
            {c.goals.map((g, i) => (
              <li key={`${g.metricKey}-${i}`} className="flex items-center justify-between rounded-[8px] border border-line px-3 py-2 text-[14px]">
                <span className="text-fg">{g.metricKey}</span>
                <span className="font-mono tabular-nums text-fg-2">
                  {g.target} {g.unit}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[14px] text-fg-2">No goals set. Goals are targets; results come only from recorded metrics and source reports.</p>
        )}
      </Panel>
      <Panel title="Deals">
        {c.deals.length ? (
          <ul className="flex flex-col gap-2">
            {c.deals.map((d) => (
              <li key={d.id} className="flex flex-col text-[14px]">
                <Link href={wsPath(`/deals/${d.id}`)} className="font-medium text-fg hover:underline">
                  {d.title}
                </Link>
                <span className="text-[12px] text-fg-2">
                  {d.partnerName} · {d.stage}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[14px] text-fg-2">No deals linked.</p>
        )}
      </Panel>
      <Panel title="Placements" className="lg:col-span-3">
        <QueryState query={previews}>
          {previews.data && previews.data.items.length ? (
            <ul className="flex flex-wrap gap-3">
              {previews.data.items.map((p) => (
                <li key={p.id}>
                  <Link href={wsPath(`/publications/${p.id}`)} className="flex w-[80px] flex-col gap-1 text-[12px] text-fg-2 hover:text-fg">
                    {p.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.thumbnailUrl} alt="" width={80} height={100} className="h-[100px] w-[80px] rounded-[8px] object-cover" loading="lazy" />
                    ) : (
                      <span aria-hidden className="flex h-[100px] w-[80px] items-center justify-center rounded-[8px] bg-surface-2 text-[11px] text-fg-muted">
                        No preview
                      </span>
                    )}
                    <span className="truncate">{p.title}</span>
                    <span className="truncate">{label('publicationStatus', p.status)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[14px] text-fg-2">No placements yet.</p>
          )}
        </QueryState>
      </Panel>
    </div>
  );
};

const Activity = ({ id }: { id: string }) => {
  const { workspace, user } = useWorkspace();
  const q = useApiInfinite(C.activity, { params: { workspaceId: workspace.id, campaignId: id }, query: {} });
  return (
    <Panel title="Activity">
      <QueryState query={q}>
        {q.items.length === 0 ? (
          <p className="text-[14px] text-fg-2">No activity yet.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {q.items.map((a) => (
              <li key={a.id} className="text-[14px]">
                <p className="text-fg">
                  {a.actorName ?? 'System'} · {a.action.replace(/^campaign\./, '').replace(/_/g, ' ')}
                </p>
                {a.changes.length ? <p className="text-[13px] text-fg-2">Changed {a.changes.map((ch) => ch.field).join(', ')}</p> : null}
                {a.reason ? <p className="text-[13px] text-fg-2">{a.reason}</p> : null}
                <p className="text-[12px] text-fg-muted">{formatDateTime(a.occurredAt, user.timezone)}</p>
              </li>
            ))}
          </ol>
        )}
        {q.hasNextPage ? (
          <div className="mt-3 flex justify-center">
            <Button onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
              Load More
            </Button>
          </div>
        ) : null}
      </QueryState>
    </Panel>
  );
};
