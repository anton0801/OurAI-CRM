import { Suspense } from 'react';
import { ContentVersionRedirect } from '@/features/content/version-redirect';

export default async function ContentVersionPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  return (
    <Suspense>
      <ContentVersionRedirect versionId={versionId} />
    </Suspense>
  );
}
