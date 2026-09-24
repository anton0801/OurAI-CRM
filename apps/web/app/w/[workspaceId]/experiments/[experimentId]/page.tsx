import { Suspense } from 'react';
import { ExperimentDetailScreen } from '@/features/experiments/experiment-detail';

export const metadata = { title: 'Experiment' };

export default async function ExperimentPage({ params }: { params: Promise<{ experimentId: string }> }) {
  const { experimentId } = await params;
  return (
    <Suspense>
      <ExperimentDetailScreen experimentId={experimentId} />
    </Suspense>
  );
}
