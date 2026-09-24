'use client';
import Link from 'next/link';
import { reportEndpoints as R } from '@castlane/api-contracts';
import { Badge, Banner, PageHeader, formatDateTime } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { STALE_REPORT } from '../metrics/common';
import { ResultView } from './result-view';

/** Immutable report snapshot: the result as of its time, with period, scope, formulas and PDF export. */
export const SnapshotScreen = ({ snapshotId }: { snapshotId: string }) => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const q = useApiQuery(R.snapshotGet, { params: { workspaceId: workspace.id, snapshotId } });
  const s = q.data;
  return (
    <QueryState query={q}>
      {s ? (
        <div className="flex flex-col gap-5">
          <PageHeader
            crumbs={[
              { label: 'Reports', href: wsPath('/reports?tab=snapshots') },
              { label: s.reportName, href: wsPath(`/reports/${s.reportId}`) },
              { label: 'Snapshot' },
            ]}
            title={`${s.reportName} · snapshot`}
            meta={
              <>
                {s.scheduled ? <Badge tone="info">Scheduled delivery</Badge> : <Badge>Saved snapshot</Badge>}
                <span className="text-[13px] text-fg-2">
                  As of {formatDateTime(s.asOf, user.timezone)} · configuration version {s.configVersion} · for {s.generatedFor.displayName}
                </span>
              </>
            }
            actions={
              <>
                {can('exports.download') ? (
                  <a href={`/api/v1/workspaces/${workspace.id}/report-snapshots/${s.id}/pdf`} className="inline-flex h-9 items-center rounded-[8px] border border-line bg-surface px-3 text-[13px] font-medium text-fg hover:bg-surface-2">
                    Download PDF
                  </a>
                ) : null}
                <Link href={wsPath(`/reports/${s.reportId}`)} className="inline-flex h-9 items-center px-2 text-[13px] font-medium text-primary hover:underline">
                  Open Report
                </Link>
              </>
            }
          />
          {s.stale ? <Banner tone="warning">{STALE_REPORT}</Banner> : null}
          <ResultView result={s.result} config={s.config} />
        </div>
      ) : null}
    </QueryState>
  );
};
