import { Suspense } from 'react';
import { EntryDetailScreen } from '@/features/finance/entry-detail';

export const metadata = { title: 'Financial Entry' };

export default async function EntryPage({ params }: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await params;
  return (
    <Suspense>
      <EntryDetailScreen entryId={entryId} />
    </Suspense>
  );
}
