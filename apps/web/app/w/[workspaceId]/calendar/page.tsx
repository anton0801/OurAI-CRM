import { Suspense } from 'react';
import { CalendarScreen } from '@/features/calendar/calendar-screen';

export const metadata = { title: 'Calendar' };

export default function CalendarPage() {
  return (
    <Suspense>
      <CalendarScreen />
    </Suspense>
  );
}
