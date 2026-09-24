import { Suspense } from 'react';
import { FinanceOverviewScreen } from '@/features/finance/overview-screen';

export const metadata = { title: 'Finance' };

export default function FinancePage() {
  return (
    <Suspense>
      <FinanceOverviewScreen />
    </Suspense>
  );
}
