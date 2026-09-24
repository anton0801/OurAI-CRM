import { Suspense } from 'react';
import { AssignmentsScreen } from '@/features/ofm/assignments-screen';

export const metadata = { title: 'OFM Assignments' };

export default function OfmAssignmentsPage() {
  return (
    <Suspense>
      <AssignmentsScreen />
    </Suspense>
  );
}
