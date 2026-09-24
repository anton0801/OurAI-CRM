'use client';
import { FilmSlate, Package, Plus } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { contentEndpoints, type ContentSummary, type ProjectDetail } from '@castlane/api-contracts';
import { Button, EmptyState, toast } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { ContentPipeline } from './content-pipeline';
import { ContentFlags, DueText, Person, StageBadge, VersionPointers } from './format';
import './labels';

/** Compact rows of content items (the same records and links as the pipeline). */
const ContentRows = ({
  items,
  action,
}: {
  items: ContentSummary[];
  action?: (c: ContentSummary) => ReactNode;
}) => {
  const wsPath = useWsPath();
  const { user } = useWorkspace();
  return (
    <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line bg-surface">
      {items.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
          {c.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={c.thumbnailUrl}
              alt=""
              width={40}
              height={40}
              loading="lazy"
              className="h-10 w-10 shrink-0 rounded-[6px] bg-surface-2 object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] bg-surface-2 text-fg-muted"
            >
              <FilmSlate size={18} />
            </span>
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Link
              href={wsPath(`/content/${c.id}`)}
              className="truncate text-[14px] font-medium text-fg hover:underline"
            >
              {c.title}
            </Link>
            <span className="flex flex-wrap items-center gap-x-2 text-[12px] text-fg-2">
              <span>{label('contentFormat', c.format)}</span>
              <span aria-hidden>·</span>
              <DueText c={c} tz={user.timezone} />
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <StageBadge stage={c.stage} />
            <ContentFlags c={c} />
            <VersionPointers c={c} />
          </span>
          <span className="hidden w-[150px] text-[13px] md:block">
            <Person member={c.owner} />
          </span>
          {action ? action(c) : null}
        </li>
      ))}
    </ul>
  );
};

const FilteredContent = ({
  query,
  emptyTitle,
  emptyDescription,
  newHref,
  allHref,
}: {
  query: { projectId?: string; accountId?: string; characterId?: string };
  emptyTitle: string;
  emptyDescription: string;
  newHref?: string;
  allHref: string;
}) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const can = useCan();
  const q = useApiInfinite(contentEndpoints.list, {
    params: { workspaceId: workspace.id },
    query: { ...query, sort: 'updatedAt', direction: 'desc', pageSize: 20 },
  });
  const newButton =
    newHref && can('content.create') ? (
      <Link
        href={wsPath(newHref)}
        className="inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-line bg-surface px-3 text-[13px] font-semibold text-fg hover:bg-surface-2"
      >
        <Plus size={14} aria-hidden /> New Content
      </Link>
    ) : undefined;
  return (
    <QueryState query={q}>
      {q.items.length === 0 ? (
        <EmptyState
          icon={<FilmSlate size={24} />}
          title={emptyTitle}
          description={emptyDescription}
          action={newButton}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <ContentRows items={q.items} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link
              href={wsPath(allHref)}
              className="text-[13px] font-medium text-fg underline-offset-2 hover:underline"
            >
              Open in Content Pipeline
            </Link>
            <span className="flex gap-2">
              {q.hasNextPage ? (
                <Button size="sm" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                  Load More
                </Button>
              ) : null}
              {newButton}
            </span>
          </div>
        </div>
      )}
    </QueryState>
  );
};

/** Project workspace tab "Content" (S15 → S22): the pipeline limited to this project. */
export const ProjectContentTab = ({ project }: { project: ProjectDetail }) => (
  <ContentPipeline projectId={project.id} embedded />
);

/** Account Detail tab "Content" (S20): content produced for this account. */
export const AccountContentTab = ({ accountId, projectId }: { accountId: string; projectId: string }) => (
  <FilteredContent
    query={{ accountId }}
    emptyTitle="No content for this account"
    emptyDescription="Content items planned for this account appear here."
    newHref={`/content/new?projectId=${projectId}&accountId=${accountId}`}
    allHref={`/content?projectId=${projectId}&view=table`}
  />
);

/** Character Profile panel "Content using this character" (S16). */
export const CharacterContentPanel = ({
  characterId,
  projectId,
}: {
  characterId: string;
  projectId: string;
}) => (
  <FilteredContent
    query={{ characterId }}
    emptyTitle="Not used in content yet"
    emptyDescription="Content items that link this character appear here, with the character version each submitted version used."
    allHref={`/content?projectId=${projectId}&view=table`}
  />
);

/** Series Structure episode panel (S17): the episode's content and its approved package. */
export const EpisodeContentPanel = ({ episodeId, projectId }: { episodeId: string; projectId: string }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const can = useCan();
  const q = useApiQuery(contentEndpoints.episodeContent, {
    params: { workspaceId: workspace.id, episodeId },
  });
  const request = useApiMutation(contentEndpoints.requestEpisodePackage, { invalidate: ['exports.'] });
  const exportPackage = async () => {
    try {
      await request.run({ params: { workspaceId: workspace.id, episodeId }, body: {} });
      toast.success('Episode package requested', 'Download it from Exports when the file is ready.');
    } catch {
      // The mutation hook already explained the error.
    }
  };
  return (
    <QueryState query={q}>
      {q.data ? (
        <div className="flex flex-col gap-3">
          {q.data.items.length === 0 ? (
            <EmptyState
              icon={<FilmSlate size={24} />}
              title="No content for this episode"
              description={
                q.data.hiddenCount
                  ? `${q.data.hiddenCount} content item${q.data.hiddenCount === 1 ? '' : 's'} of this episode are outside your access.`
                  : 'Create content for the episode to plan and review it.'
              }
              action={
                can('content.create') ? (
                  <Link
                    href={wsPath(`/content/new?projectId=${projectId}&episodeId=${episodeId}`)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-line bg-surface px-3 text-[13px] font-semibold text-fg hover:bg-surface-2"
                  >
                    <Plus size={14} aria-hidden /> New Content
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <>
              <ContentRows
                items={q.data.items}
                action={(c) =>
                  can('tasks.create') && c.stage !== 'archived' ? (
                    <Link
                      href={wsPath(`/content/${c.id}?tab=tasks&action=apply-template`)}
                      className="inline-flex h-8 items-center rounded-[8px] border border-line bg-surface px-2.5 text-[12px] font-semibold text-fg hover:bg-surface-2"
                    >
                      Generate Production Tasks
                    </Link>
                  ) : null
                }
              />
              {q.data.hiddenCount ? (
                <p className="text-[12px] text-fg-2">
                  {q.data.hiddenCount} more item{q.data.hiddenCount === 1 ? ' is' : 's are'} outside your
                  access.
                </p>
              ) : null}
            </>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            {can('content.create') && q.data.items.length ? (
              <Link
                href={wsPath(`/content/new?projectId=${projectId}&episodeId=${episodeId}`)}
                className="inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-line bg-surface px-3 text-[13px] font-semibold text-fg hover:bg-surface-2"
              >
                <Plus size={14} aria-hidden /> New Content
              </Link>
            ) : null}
            {can('exports.create') ? (
              <Button
                size="sm"
                icon={<Package size={14} />}
                disabled={q.data.approvedCount === 0}
                loading={request.isPending}
                onClick={() => void exportPackage()}
                title={q.data.approvedCount === 0 ? 'No approved content in this episode yet.' : undefined}
              >
                Export Episode Package
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </QueryState>
  );
};
