'use client';
import { ACCOUNT_TABS, CONTENT_PANELS, DEAL_PANELS, EPISODE_PANELS, MY_WORK_SECTIONS } from '@/lib/slots';
import { useCan, useWsPath } from '@/lib/workspace-context';
import { PublicationTable } from './publication-list';
import { PublicationsDueSection } from './publications-due-section';

/**
 * Publishing contributions to other modules' screens (lib/slots.ts). Every panel renders the same
 * placements as the calendar through the publications list endpoint — never copies.
 */

const AccountPublicationsTab = ({ accountId }: { accountId: string; projectId: string }) => {
  const can = useCan();
  const wsPath = useWsPath();
  return (
    <PublicationTable
      filters={{ accountId }}
      caption="Account publications"
      hideAccount
      newHref={can('publications.write') ? wsPath(`/publications/new?accountId=${accountId}`) : null}
      emptyText="Plan placements of approved content on this account. Account links do not import statistics or publish content."
    />
  );
};

const ContentPublicationsPanel = ({ contentId }: { contentId: string; projectId: string; tab: 'publications' | 'results' }) => {
  const can = useCan();
  const wsPath = useWsPath();
  return (
    <PublicationTable
      filters={{ contentItemId: contentId }}
      caption="Placements of this content"
      statusParam="cpstatus"
      emptyTitle="Not placed yet"
      emptyText="One content item on two accounts is two placements. Historical placements keep the version they used."
      newHref={can('publications.write') ? wsPath(`/publications/new?contentItemId=${contentId}`) : null}
    />
  );
};

const EpisodePublicationsPanel = ({ episodeId }: { episodeId: string; projectId: string }) => (
  <PublicationTable filters={{ episodeId }} caption="Placements of this episode" statusParam="epstatus" emptyTitle="No placements of this episode" emptyText="Trailers and episode content appear here once they are planned on an account." hideProject />
);

const DealPublicationsPanel = ({ dealId }: { dealId: string }) => (
  <PublicationTable
    filters={{ dealId }}
    caption="Placements of deliverables"
    statusParam="dpstatus"
    emptyTitle="No placements for this deal yet"
    emptyText="Placements of the deliverables’ content and of the deal’s campaign appear here."
  />
);

ACCOUNT_TABS.register({ key: 'publications', label: 'Publications', order: 10, visible: (_p, can) => can('publications.read'), component: AccountPublicationsTab });
MY_WORK_SECTIONS.register({ key: 'publications-due', label: 'Publications Due', order: 20, visible: (_p, can) => can('publications.read'), component: PublicationsDueSection });
// The content detail renders CONTENT_PANELS in its Publications/Results tab and passes `tab`.
CONTENT_PANELS.register({ key: 'publications', label: 'Publications', order: 40, visible: (p, can) => p.tab === 'publications' && can('publications.read'), component: ContentPublicationsPanel });
EPISODE_PANELS.register({ key: 'publications', label: 'Publications', order: 40, visible: (_p, can) => can('publications.read'), component: EpisodePublicationsPanel });
DEAL_PANELS.register({ key: 'placements', label: 'Deliverable placements', order: 40, visible: (_p, can) => can('publications.read'), component: DealPublicationsPanel });
