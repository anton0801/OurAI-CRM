import { Suspense } from 'react';
import { ContentDetailScreen } from '@/features/content/content-detail';

export default async function ContentDetailPage({ params }: { params: Promise<{ contentId: string }> }) {
  const { contentId } = await params;
  return (
    <Suspense>
      <ContentDetailScreen contentId={contentId} />
    </Suspense>
  );
}
