import { Suspense } from 'react';
import { PublicationDetailScreen } from '@/features/publications/publication-detail';

export const metadata = { title: 'Publication' };

export default async function PublicationPage({ params }: { params: Promise<{ publicationId: string }> }) {
  const { publicationId } = await params;
  return (
    <Suspense>
      <PublicationDetailScreen publicationId={publicationId} />
    </Suspense>
  );
}
