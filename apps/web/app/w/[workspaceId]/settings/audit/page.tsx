import { Suspense } from 'react';
import { AuditScreen } from '@/features/audit/audit-screen';

export const metadata = { title: 'Audit Log' };

export default function AuditPage() {
  return (
    <Suspense>
      <AuditScreen />
    </Suspense>
  );
}
