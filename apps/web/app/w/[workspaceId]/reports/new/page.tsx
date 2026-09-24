import { Suspense } from 'react';
import { NewReportScreen } from '@/features/reports/report-builder';

export const metadata = { title: 'New Report' };

export default function Page() {
  return (
    <Suspense>
      <NewReportScreen />
    </Suspense>
  );
}
