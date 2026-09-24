import { Suspense } from 'react';
import { ReferencesScreen } from '@/features/references/references-screen';

export const metadata = { title: 'References' };

export default function ReferencesPage() {
  return (
    <Suspense>
      <ReferencesScreen />
    </Suspense>
  );
}
