import { Suspense } from 'react';
import { ArchiveScreen } from '@/features/archive/archive-screen';

export const metadata = { title: 'Archive & Trash' };

export default function ArchivePage() {
  return (
    <Suspense>
      <ArchiveScreen />
    </Suspense>
  );
}
