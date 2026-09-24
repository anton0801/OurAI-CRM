'use client';
import { FileText } from '@phosphor-icons/react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, Panel } from '@castlane/ui';
import { FileUploader } from '@/components/media/file-uploader';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';

type Evidence = { assetId: string; name: string; mime: string | null; status: string | null; thumbnailUrl: string | null };

const STATUS: Record<string, string> = { uploading: 'Uploading', checking: 'Your file is being checked and prepared for preview.', processing: 'Your file is being checked and prepared for preview.', rejected: 'Rejected', failed: 'Upload failed' };

/**
 * Receipts and statements (S56/S60): up to three 72×96 previews, the rest as a list. Shown only to
 * evidence viewers — the server omits the list otherwise.
 */
export const EvidencePanel = ({
  entityType,
  entityId,
  evidence,
  canAttach,
  locked,
}: {
  entityType: 'financial_entry' | 'settlement';
  entityId: string;
  evidence: Evidence[] | undefined;
  canAttach: boolean;
  locked?: boolean;
}) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const qc = useQueryClient();
  if (evidence === undefined) return null;
  const previews = evidence.slice(0, 3);
  const rest = evidence.slice(3);
  return (
    <Panel title="Evidence" description={locked ? 'Posted evidence is kept with the record.' : 'Receipts, invoices and platform statements'}>
      <div className="flex flex-col gap-3">
        {evidence.length === 0 ? <p className="text-[13px] text-fg-2">No files attached.</p> : null}
        {previews.length ? (
          <ul className="flex flex-wrap gap-3">
            {previews.map((e) => (
              <li key={e.assetId}>
                <Link href={wsPath(`/library/assets/${e.assetId}`)} className="flex w-[72px] flex-col gap-1" title={e.name}>
                  {e.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={e.thumbnailUrl} alt={e.name} width={72} height={96} loading="lazy" className="h-24 w-[72px] rounded-[6px] border border-line object-cover" />
                  ) : (
                    <span className="flex h-24 w-[72px] items-center justify-center rounded-[6px] border border-line bg-surface-2 text-fg-2">
                      <FileText size={22} aria-hidden />
                    </span>
                  )}
                  <span className="truncate text-[11px] text-fg-2">{e.name}</span>
                </Link>
                {e.status && e.status !== 'available' ? (
                  <Badge tone={e.status === 'rejected' || e.status === 'failed' ? 'danger' : 'info'} className="mt-1 max-w-[72px] truncate" title={STATUS[e.status] ?? e.status}>
                    {e.status === 'rejected' || e.status === 'failed' ? 'Rejected' : 'Checking'}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {rest.length ? (
          <ul className="flex flex-col gap-1 text-[13px]">
            {rest.map((e) => (
              <li key={e.assetId}>
                <Link href={wsPath(`/library/assets/${e.assetId}`)} className="text-primary hover:underline">
                  {e.name}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {canAttach ? (
          <FileUploader
            compact
            workspaceId={workspace.id}
            purpose="evidence"
            target={{ entityType, entityId, role: 'evidence' }}
            label="Attach Evidence"
            hint="PDF or image. Files are checked before they can be previewed."
            accept="application/pdf,image/*"
            onUploaded={() => void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('finance.') })}
          />
        ) : null}
      </div>
    </Panel>
  );
};
