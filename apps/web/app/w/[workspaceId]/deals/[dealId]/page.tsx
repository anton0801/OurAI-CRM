import { Suspense } from 'react';
import { DealWorkspace } from '@/features/partners/deal-workspace';

export const metadata = { title: 'Partnership Deal' };

export default async function DealPage({ params }: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await params;
  return (
    <Suspense>
      <DealWorkspace dealId={dealId} />
    </Suspense>
  );
}
