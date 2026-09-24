import { Suspense } from 'react';
import { ShiftWorkspace } from '@/features/ofm/shift-workspace';

export const metadata = { title: 'Shift' };

export default async function OfmShiftPage({ params }: { params: Promise<{ shiftId: string }> }) {
  const { shiftId } = await params;
  return (
    <Suspense>
      <ShiftWorkspace shiftId={shiftId} />
    </Suspense>
  );
}
