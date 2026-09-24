import { Suspense } from 'react';
import { ExperimentsScreen } from '@/features/experiments/experiments-screen';

export const metadata = { title: 'Experiments' };

export default function ExperimentsPage() {
  return (
    <Suspense>
      <ExperimentsScreen />
    </Suspense>
  );
}
