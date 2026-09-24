import { Suspense } from 'react';
import { NewPublicationScreen } from '@/features/publications/publication-editor';

export const metadata = { title: 'New Publication' };

export default function NewPublicationPage() {
  return (
    <Suspense>
      <NewPublicationScreen />
    </Suspense>
  );
}
