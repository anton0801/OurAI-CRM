'use client';
import { CalendarCheck } from '@phosphor-icons/react';
import Link from 'next/link';
import { useState } from 'react';
import { publicationEndpoints as P, type PublicationRow } from '@castlane/api-contracts';
import { Button, EmptyState } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { PlatformLabel } from '@/features/accounts/platform';
import { PublicationBadges, whenText } from './format';
import { SCHEDULED_NOTE } from './labels';
import { MarkPublishedDialog, ReasonDialog } from './publication-dialogs';

/** My Work "Publications Due" (S09): the member's scheduled placements with Mark Published in place. */
export const PublicationsDueSection = () => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const can = useCan();
  const q = useApiQuery(P.due, { params: { workspaceId: workspace.id }, query: { limit: 20 } });
  const [publishing, setPublishing] = useState<PublicationRow | null>(null);
  const [failing, setFailing] = useState<PublicationRow | null>(null);
  return (
    <QueryState query={q}>
      {q.data && q.data.items.length ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-fg-2">
            {SCHEDULED_NOTE}
            {q.data.awaitingConfirmation ? ` ${q.data.awaitingConfirmation} placement(s) passed their planned time without confirmation.` : ''}
          </p>
          <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line bg-surface" aria-label="Publications due">
            {q.data.items.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <Link href={wsPath(`/publications/${p.id}`)} className="block truncate text-[14px] font-medium text-fg hover:underline">
                    {p.title}
                  </Link>
                  <span className="flex flex-wrap items-center gap-2 text-[12px] text-fg-2">
                    <PlatformLabel platform={p.account.platform} iconOnly /> {p.account.label} · {whenText(p, user.timezone)}
                  </span>
                </span>
                <PublicationBadges p={p} compact />
                {can('publications.confirm') ? (
                  <span className="flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => setPublishing(p)}>
                      Mark Published
                    </Button>
                    <Button size="sm" onClick={() => setFailing(p)}>
                      Mark Failed
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {q.data.total > q.data.items.length ? (
            <p className="text-[13px] text-fg-2">
              Showing {q.data.items.length} of {q.data.total}.{' '}
              <Link className="text-fg underline" href={wsPath('/calendar?view=agenda')}>
                See all in the Calendar
              </Link>
            </p>
          ) : null}
        </div>
      ) : (
        <EmptyState icon={<CalendarCheck size={24} />} title="No publications due" description="Scheduled placements you own for the next 7 days appear here until you confirm them." />
      )}
      {publishing ? <MarkPublishedDialog publication={publishing} open onOpenChange={(o) => !o && setPublishing(null)} /> : null}
      {failing ? <ReasonDialog publication={failing} kind="fail" open onOpenChange={(o) => !o && setFailing(null)} /> : null}
    </QueryState>
  );
};
