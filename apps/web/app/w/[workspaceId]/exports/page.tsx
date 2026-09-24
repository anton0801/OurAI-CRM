import { Suspense } from 'react';
import { ExportsScreen } from '@/features/exports/exports-screen';

export const metadata = { title: 'Export Center' };

export default function ExportsPage() {
  return (
    <Suspense>
      <ExportsScreen />
    </Suspense>
  );
}
