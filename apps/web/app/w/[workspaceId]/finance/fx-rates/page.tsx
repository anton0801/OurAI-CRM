import { Suspense } from 'react';
import { FxRatesScreen } from '@/features/finance/settings-screens';

export const metadata = { title: 'FX Rates' };

export default function FxRatesPage() {
  return (
    <Suspense>
      <FxRatesScreen />
    </Suspense>
  );
}
