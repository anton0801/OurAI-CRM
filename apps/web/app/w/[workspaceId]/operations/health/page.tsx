import { Suspense } from 'react';
import { HealthScreen } from '@/features/health/health-screen';

export const metadata = { title: 'Incidents & Health' };

export default function HealthPage() {
  return (
    <Suspense>
      <HealthScreen />
    </Suspense>
  );
}
