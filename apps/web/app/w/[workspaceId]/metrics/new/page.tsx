import { Suspense } from 'react';
import { NewMetricsScreen } from '@/features/metrics/new-screen';

export const metadata = { title: 'Add Metrics' };

export default function Page() {
  return (
    <Suspense>
      <NewMetricsScreen />
    </Suspense>
  );
}
