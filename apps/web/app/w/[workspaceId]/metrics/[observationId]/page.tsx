import { Suspense } from 'react';
import { ObservationDetailScreen } from '@/features/metrics/observation-detail';

export const metadata = { title: 'Metric Observation' };

export default async function Page({ params }: { params: Promise<{ observationId: string }> }) {
  const { observationId } = await params;
  return (
    <Suspense>
      <ObservationDetailScreen observationId={observationId} />
    </Suspense>
  );
}
