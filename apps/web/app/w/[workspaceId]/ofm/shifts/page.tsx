import { Suspense } from 'react';
import { ShiftScheduleScreen } from '@/features/ofm/schedule-screen';

export const metadata = { title: 'Shift Schedule' };

export default function OfmShiftsPage() {
  return (
    <Suspense>
      <ShiftScheduleScreen />
    </Suspense>
  );
}
