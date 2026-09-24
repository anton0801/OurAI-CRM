import { Suspense } from 'react';
import { MetricsInboxScreen } from '@/features/metrics/inbox-screen';

export const metadata = { title: 'Metrics' };

export default function Page() {
  return (
    <Suspense>
      <MetricsInboxScreen />
    </Suspense>
  );
}
