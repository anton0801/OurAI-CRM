import { Suspense } from 'react';
import { RulesScreen } from '@/features/finance/rules-screen';

export const metadata = { title: 'Compensation Rules' };

export default function CompensationRulesPage() {
  return (
    <Suspense>
      <RulesScreen />
    </Suspense>
  );
}
