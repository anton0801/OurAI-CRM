import { Suspense } from 'react';
import { RunsScreen } from '@/features/finance/runs-screen';

export const metadata = { title: 'Compensation Runs' };

export default function CompensationRunsPage() {
  return (
    <Suspense>
      <RunsScreen />
    </Suspense>
  );
}
