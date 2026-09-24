import { Suspense } from 'react';
import { ContentPipeline } from '@/features/content/content-pipeline';

export const metadata = { title: 'Content' };

export default function ContentPage() {
  return (
    <Suspense>
      <ContentPipeline />
    </Suspense>
  );
}
