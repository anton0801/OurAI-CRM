import { Suspense } from 'react';
import { ReportScreen } from '@/features/reports/report-builder';

export const metadata = { title: 'Report' };

export default async function Page({ params }: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await params;
  return (
    <Suspense>
      <ReportScreen reportId={reportId} />
    </Suspense>
  );
}
