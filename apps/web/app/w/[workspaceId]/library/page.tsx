import { Suspense } from 'react';
import { LibraryScreen } from '@/features/library/library-screen';

export const metadata = { title: 'Library' };

export default function LibraryPage() {
  return (
    <Suspense>
      <LibraryScreen />
    </Suspense>
  );
}
