import { Suspense } from 'react';
import { OfmOverviewScreen } from '@/features/ofm/overview-screen';

export const metadata = { title: 'OFM' };

export default function OfmOverviewPage() {
  return (
    <Suspense>
      <OfmOverviewScreen />
    </Suspense>
  );
}
