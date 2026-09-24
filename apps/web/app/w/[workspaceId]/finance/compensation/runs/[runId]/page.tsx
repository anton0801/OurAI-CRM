import { Suspense } from 'react';
import { RunDetailScreen } from '@/features/finance/run-detail';

export const metadata = { title: 'Compensation Run' };

export default async function CompensationRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return (
    <Suspense>
      <RunDetailScreen runId={runId} />
    </Suspense>
  );
}
