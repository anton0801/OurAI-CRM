import { Suspense } from 'react';
import { AnalyticsScreen } from '@/features/analytics/analytics-screen';

export const metadata = { title: 'Analytics' };

export default function Page() {
  return (
    <Suspense>
      <AnalyticsScreen />
    </Suspense>
  );
}
