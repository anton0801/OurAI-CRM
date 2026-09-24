'use client';
import { timeEndpoints } from '@castlane/api-contracts';
import { TIME_ENTRY_STATES } from '@castlane/domain';
import { DateInput, EmptyState, MultiSelect, NoResults, Switch, Toolbar } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { formatSeconds } from '../tasks/format';
import { EntryTable } from './entry-table';

type Keys = 'from' | 'to' | 'member' | 'project' | 'state' | 'superseded';

/** All entries you may see: your own, plus members’ entries where you hold time.read.scope. Filters live in the URL. */
export const EntriesView = () => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const { state, set, list } = useUrlState<Keys>();
  const query = {
    from: state.from || undefined,
    to: state.to || undefined,
    membershipId: state.member || undefined,
    projectId: state.project || undefined,
    state: list('state') as (typeof TIME_ENTRY_STATES)[number][],
    includeSuperseded: state.superseded === '1' ? true : undefined,
  };
  const data = useApiInfinite(timeEndpoints.list, { params: { workspaceId: workspace.id }, query });
  const filtered = !!(query.from || query.to || query.membershipId || query.projectId || query.state.length);
  const scope = can('time.read.scope');
  const total = (data.data?.pages as { totalSeconds?: number }[] | undefined)?.[0]?.totalSeconds;
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-[150px]">
          <DateInput aria-label="From date" value={state.from ?? ''} onChange={(e) => set({ from: e.target.value || null })} />
        </div>
        <div className="w-[150px]">
          <DateInput aria-label="To date" value={state.to ?? ''} onChange={(e) => set({ to: e.target.value || null })} />
        </div>
        {scope ? (
          <div className="w-[190px]">
            <MemberSelect value={state.member} onChange={(v) => set({ member: v })} clearable placeholder="Member" />
          </div>
        ) : null}
        <div className="w-[190px]">
          <EntitySelect type="project" aria-label="Project" placeholder="Project" value={state.project} onChange={(v) => set({ project: v })} clearable />
        </div>
        <div className="w-[170px]">
          <MultiSelect aria-label="State" placeholder="State" value={list('state')} onChange={(v) => set({ state: v.join(',') || null })} options={TIME_ENTRY_STATES.map((s) => ({ value: s, label: label('timeState', s) }))} />
        </div>
        <Switch label="Show replaced" checked={state.superseded === '1'} onCheckedChange={(v) => set({ superseded: v ? '1' : null })} />
        {typeof total === 'number' ? (
          <span className="ml-auto text-[13px] text-fg-2">
            Total: <span className="font-mono tabular-nums text-fg">{formatSeconds(total)}</span>
          </span>
        ) : null}
      </Toolbar>
      <QueryState query={data}>
        {data.items.length === 0 && !data.isFetching ? (
          filtered ? (
            <NoResults onClear={() => set({ from: null, to: null, member: null, project: null, state: null, superseded: null })} />
          ) : (
            <EmptyState title="No time entries" description={scope ? 'No one in your scope recorded time yet.' : 'You have not recorded time yet. Start a timer on a task or add an entry.'} />
          )
        ) : (
          <EntryTable
            entries={data.items}
            caption="Time entries"
            showMember={scope}
            hasMore={data.hasNextPage}
            loadingMore={data.isFetchingNextPage}
            onLoadMore={() => void data.fetchNextPage()}
          />
        )}
      </QueryState>
    </div>
  );
};
