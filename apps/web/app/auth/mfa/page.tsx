import { Suspense } from 'react';
import { MfaFlow } from './mfa-flow';

export const metadata = { title: 'Two-factor authentication' };

export default function MfaPage() {
  return (
    <Suspense>
      <MfaFlow />
    </Suspense>
  );
}
