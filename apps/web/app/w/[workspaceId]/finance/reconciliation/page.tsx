import { Suspense } from 'react';
import { ReconciliationScreen } from '@/features/finance/reconciliation-screen';

export const metadata = { title: 'Sale Reconciliation' };

export default function ReconciliationPage() {
  return (
    <Suspense>
      <ReconciliationScreen />
    </Suspense>
  );
}
