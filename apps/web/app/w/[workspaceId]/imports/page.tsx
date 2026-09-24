import { Suspense } from 'react';
import { ImportsScreen } from '@/features/imports/imports-screen';

export const metadata = { title: 'Import Center' };

export default function ImportsPage() {
  return (
    <Suspense>
      <ImportsScreen />
    </Suspense>
  );
}
