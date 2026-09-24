import { Suspense } from 'react';
import { BudgetsScreen } from '@/features/finance/budgets-screen';

export const metadata = { title: 'Budgets' };

export default function BudgetsPage() {
  return (
    <Suspense>
      <BudgetsScreen />
    </Suspense>
  );
}
