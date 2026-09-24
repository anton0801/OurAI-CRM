import { Suspense } from 'react';
import { OperationsScreen } from '@/features/ofm/operations-screen';

export const metadata = { title: 'Operations Queue' };

export default function OfmOperationsPage() {
  return (
    <Suspense>
      <OperationsScreen />
    </Suspense>
  );
}
