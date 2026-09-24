import { Suspense } from 'react';
import { TimeScreen } from '@/features/time/time-screen';

export const metadata = { title: 'Time Entries' };

export default function TimePage() {
  return (
    <Suspense>
      <TimeScreen />
    </Suspense>
  );
}
