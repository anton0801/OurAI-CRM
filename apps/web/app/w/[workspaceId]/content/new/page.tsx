import { Suspense } from 'react';
import { ContentEditor } from '@/features/content/content-editor';

export const metadata = { title: 'New Content' };

export default function NewContentPage() {
  return (
    <Suspense>
      <ContentEditor />
    </Suspense>
  );
}
