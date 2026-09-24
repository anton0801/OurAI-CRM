'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Archive, ArrowCounterClockwise, BellSimpleSlash, Checks, Envelope, EnvelopeOpen, GearSix, ShieldWarning, Tray } from '@phosphor-icons/react';
import { useState } from 'react';
import { inboxEndpoints, type NotificationItem } from '@castlane/api-contracts';
import { Avatar, Badge, Button, ConfirmDialog, EmptyState, IconButton, NoResults, PageHeader, Select, Tabs, TableSkeleton, Toolbar, cn, formatDateTime, formatRelative } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import './labels';

type Filters = 'view' | 'eventType' | 'projectId';
type View = 'unread' | 'all' | 'archived';

const EMPTY: Record<View, { title: string; description: string }> = {
  unread: { title: 'No unread notifications', description: 'New review requests, assignments and reminders appear here as soon as they happen.' },
  all: { title: 'No notifications yet', description: 'Notifications about work assigned to you or waiting for your decision appear here.' },
  archived: { title: 'Nothing archived', description: 'Archive notifications you have handled to keep the inbox focused.' },
};

/** S10 Inbox: personal notifications; excerpts respect current access; reading never completes work. */
export const InboxScreen = () => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set } = useUrlState<Filters>({ view: 'unread' });
  const view = (state.view ?? 'unread') as View;
  const params = { workspaceId: workspace.id };
  const filter = { eventType: state.eventType, projectId: state.projectId };
  const list = useApiInfinite(inboxEndpoints.list, { params, query: { view, ...filter } });
  const facets = useApiQuery(inboxEndpoints.facets, { params }, { staleTime: 30_000 });
  const [confirm, setConfirm] = useState<{ count: number; asOf: string } | null>(null);
  const invalidate = ['notifications.list', 'notifications.facets', 'notifications.unreadCount'];
  const setRead = useApiMutation(inboxEndpoints.setRead, { invalidate });
  const setArchived = useApiMutation(inboxEndpoints.setArchived, { invalidate });
  const preview = useApiMutation(inboxEndpoints.markReadPreview);
  const markRead = useApiMutation(inboxEndpoints.markRead, { invalidate, successMessage: (r) => `${r.updated} notification${r.updated === 1 ? '' : 's'} marked as read` });
  const filtered = !!(state.eventType || state.projectId);
  const unreadTotal = (facets.data?.eventTypes ?? []).reduce((n, f) => n + f.unread, 0);

  const open = async (n: NotificationItem) => {
    if (!n.readAt) await setRead.run({ params: { ...params, notificationId: n.id }, body: { read: true } }).catch(() => undefined);
    if (n.href) router.push(n.href);
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Inbox"
        description="Review requests, assignments, reminders and alerts addressed to you. Marking a notification as read does not complete the work."
        actions={
          <>
            <Button
              icon={<Checks size={14} />}
              disabled={view === 'archived'}
              loading={preview.isPending}
              onClick={async () => setConfirm(await preview.run({ params, body: filter }))}
            >
              Mark All Read
            </Button>
            <Link href={wsPath('/settings/profile#notifications')} className="inline-flex h-11 items-center gap-2 rounded-[8px] border border-line bg-surface px-[14px] text-[13px] font-semibold text-fg hover:bg-surface-2 md:h-9">
              <GearSix size={14} aria-hidden /> Notification settings
            </Link>
          </>
        }
      />
      <Tabs
        label="Inbox views"
        value={view}
        onValueChange={(v) => set({ view: v })}
        items={[
          { value: 'unread', label: 'Unread', count: facets.data ? unreadTotal : undefined },
          { value: 'all', label: 'All' },
          { value: 'archived', label: 'Archived' },
        ]}
      />
      <Toolbar>
        <div className="w-full sm:w-[220px]">
          <Select
            aria-label="Type"
            placeholder="All types"
            clearable
            value={state.eventType ?? null}
            onChange={(v) => set({ eventType: v })}
            options={(facets.data?.eventTypes ?? []).map((f) => ({ value: f.eventType, label: label('notificationEvent', f.eventType), description: `${f.unread} unread of ${f.total}` }))}
          />
        </div>
        <div className="w-full sm:w-[220px]">
          <Select aria-label="Project" placeholder="All projects" clearable value={state.projectId ?? null} onChange={(v) => set({ projectId: v })} options={(facets.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} />
        </div>
      </Toolbar>
      <QueryState query={list} skeleton={<TableSkeleton rows={6} columns={3} />}>
        {list.items.length === 0 && !list.isFetching ? (
          filtered ? (
            <NoResults onClear={() => set({ eventType: null, projectId: null })} />
          ) : (
            <EmptyState icon={<Tray size={28} />} title={EMPTY[view].title} description={EMPTY[view].description} />
          )
        ) : (
          <div className="flex flex-col gap-3">
            <ul className="divide-y divide-line overflow-hidden rounded-[12px] border border-line bg-surface" aria-label="Notifications">
              {list.items.map((n) => (
                <li key={n.id} className={cn('flex items-start gap-3 px-4 py-3', !n.readAt && view !== 'archived' && 'bg-selection/40')}>
                  <span className="pt-0.5">
                    {n.security ? (
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-warning-soft text-warning" aria-hidden>
                        <ShieldWarning size={16} />
                      </span>
                    ) : n.actor ? (
                      <Avatar name={n.actor.displayName} src={n.actor.avatarUrl} size={28} decorative />
                    ) : (
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-fg-2" aria-hidden>
                        <Envelope size={14} />
                      </span>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" onClick={() => void open(n)} className={cn('text-left text-[14px] leading-[22px] text-fg hover:underline', !n.readAt && 'font-semibold')}>
                        {n.title}
                      </button>
                      {!n.readAt ? <Badge tone="info">Unread</Badge> : null}
                      {n.security ? <Badge tone="warning">Security</Badge> : null}
                    </div>
                    {n.accessRevoked ? (
                      <p className="flex items-center gap-1 text-[13px] text-fg-2">
                        <BellSimpleSlash size={12} aria-hidden /> Your access to this item has changed.
                      </p>
                    ) : n.excerpt ? (
                      <p className="line-clamp-2 text-[13px] leading-5 text-fg-2">{n.excerpt}</p>
                    ) : null}
                    <p className="mt-0.5 text-[12px] leading-[18px] text-fg-muted">
                      {label('notificationEvent', n.eventType)}
                      {n.actor ? ` · ${n.actor.displayName}` : ''} · <time dateTime={n.createdAt} title={formatDateTime(n.createdAt, user.timezone)}>{formatRelative(n.createdAt)}</time>
                    </p>
                  </div>
                  {n.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={n.thumbnailUrl} alt="" width={40} height={40} loading="lazy" className="hidden h-10 w-10 shrink-0 rounded-[8px] object-cover sm:block" />
                  ) : null}
                  <div className="flex shrink-0 items-center gap-1">
                    {n.href ? (
                      <Button size="sm" onClick={() => void open(n)}>
                        Open
                      </Button>
                    ) : null}
                    {view !== 'archived' ? (
                      <IconButton
                        label={n.readAt ? 'Mark as unread' : 'Mark as read'}
                        icon={n.readAt ? <Envelope size={16} /> : <EnvelopeOpen size={16} />}
                        onClick={() => void setRead.run({ params: { ...params, notificationId: n.id }, body: { read: !n.readAt } })}
                      />
                    ) : null}
                    <IconButton
                      label={n.archivedAt ? 'Move back to inbox' : 'Archive'}
                      icon={n.archivedAt ? <ArrowCounterClockwise size={16} /> : <Archive size={16} />}
                      onClick={() => void setArchived.run({ params: { ...params, notificationId: n.id }, body: { archived: !n.archivedAt } })}
                    />
                  </div>
                </li>
              ))}
            </ul>
            {list.hasNextPage ? (
              <div className="flex justify-center">
                <Button onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
                  Load More
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </QueryState>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.count ? `Mark ${confirm.count} notification${confirm.count === 1 ? '' : 's'} as read?` : 'Nothing to mark as read'}
        body={
          confirm?.count
            ? `Only unread notifications matching the current filter${filtered ? '' : ' (all types and projects)'} that arrived before now are marked. Notifications that arrive later stay unread. Reading does not complete the underlying work.`
            : 'There are no unread notifications for the current filter.'
        }
        confirmLabel="Mark All Read"
        confirmDisabled={!confirm?.count}
        loading={markRead.isPending}
        onConfirm={async () => {
          if (!confirm) return;
          await markRead.run({ params, body: { ...filter, asOf: confirm.asOf } });
          setConfirm(null);
        }}
      />
    </div>
  );
};
