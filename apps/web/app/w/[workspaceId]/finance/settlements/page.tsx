import { Suspense } from 'react';
import { SettlementsScreen } from '@/features/finance/settlements-screen';

export const metadata = { title: 'Settlements' };

export default function SettlementsPage() {
  return (
    <Suspense>
      <SettlementsScreen />
    </Suspense>
  );
}
