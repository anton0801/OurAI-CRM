import { Suspense } from 'react';
import { WorkloadScreen } from '@/features/workload/workload-screen';

export const metadata = { title: 'Workload' };

export default function WorkloadPage() {
  return (
    <Suspense>
      <WorkloadScreen />
    </Suspense>
  );
}
