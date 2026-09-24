import { Suspense } from 'react';
import { ReportsScreen } from '@/features/reports/reports-screen';

export const metadata = { title: 'Reports' };

export default function Page() {
  return (
    <Suspense>
      <ReportsScreen />
    </Suspense>
  );
}
