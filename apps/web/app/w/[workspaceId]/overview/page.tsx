import { Suspense } from 'react';
import { OverviewScreen } from '@/features/overview/overview-screen';

export const metadata = { title: 'Overview' };

export default function OverviewPage() {
  return (
    <Suspense>
      <OverviewScreen />
    </Suspense>
  );
}
