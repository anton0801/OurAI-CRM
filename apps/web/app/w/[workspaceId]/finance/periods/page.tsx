import { Suspense } from 'react';
import { PeriodsScreen } from '@/features/finance/periods-screen';

export const metadata = { title: 'Finance Periods' };

export default function PeriodsPage() {
  return (
    <Suspense>
      <PeriodsScreen />
    </Suspense>
  );
}
