import { Suspense } from 'react';
import { NewEntryScreen } from '@/features/finance/entry-editor';

export const metadata = { title: 'New Financial Entry' };

export default function NewEntryPage() {
  return (
    <Suspense>
      <NewEntryScreen />
    </Suspense>
  );
}
