import { Suspense } from 'react';
import { SeriesStructure } from '@/features/series/series-structure';

export const metadata = { title: 'Series Structure' };

export default async function SeriesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return (
    <Suspense>
      <SeriesStructure projectId={projectId} />
    </Suspense>
  );
}
