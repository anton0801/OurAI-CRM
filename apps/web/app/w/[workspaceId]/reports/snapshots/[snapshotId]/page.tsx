import { Suspense } from 'react';
import { SnapshotScreen } from '@/features/reports/snapshot-screen';

export const metadata = { title: 'Report Snapshot' };

export default async function Page({ params }: { params: Promise<{ snapshotId: string }> }) {
  const { snapshotId } = await params;
  return (
    <Suspense>
      <SnapshotScreen snapshotId={snapshotId} />
    </Suspense>
  );
}
