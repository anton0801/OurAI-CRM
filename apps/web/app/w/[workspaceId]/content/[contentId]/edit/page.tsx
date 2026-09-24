import { Suspense } from 'react';
import { ContentEditScreen } from '@/features/content/content-editor';

export const metadata = { title: 'Edit Content' };

export default async function EditContentPage({ params }: { params: Promise<{ contentId: string }> }) {
  const { contentId } = await params;
  return (
    <Suspense>
      <ContentEditScreen contentId={contentId} />
    </Suspense>
  );
}
