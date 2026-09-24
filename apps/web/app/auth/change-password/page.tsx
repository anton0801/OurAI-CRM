'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { authEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Button, Field, Input } from '@castlane/ui';
import { AuthCard, FormError } from '@/components/auth/auth-card';
import { api, setCsrfToken } from '@/lib/api';

const ChangePassword = () => {
  const params = useSearchParams();
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    api
      .call(authEndpoints.me, {})
      .then((me) => setCsrfToken(me.csrfToken))
      .catch(() => window.location.assign('/auth/sign-in'));
  }, []);
  return (
    <AuthCard title="Change your temporary password" description="You signed in with a temporary password. Choose a personal password to continue.">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(null);
          try {
            await api.call(authEndpoints.changePassword, { body: { currentPassword: current, newPassword: pw } });
            const to = params.get('returnTo');
            window.location.assign(to && to.startsWith('/') && !to.startsWith('//') ? to : '/');
          } catch (err) {
            setError(isApiError(err) ? (err.fieldErrors[0]?.message ?? err.message) : 'The password could not be changed.');
            setPending(false);
          }
        }}
      >
        <FormError message={error} />
        <Field label="Current Password" required>
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New Password" required helper="12–128 characters.">
          <Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Field label="Confirm Password" required error={pw2 && pw !== pw2 ? 'The passwords do not match.' : null}>
          <Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" loading={pending} disabled={!current || pw.length < 12 || pw !== pw2}>
          Change Password
        </Button>
      </form>
    </AuthCard>
  );
};

export default function Page() {
  return (
    <Suspense>
      <ChangePassword />
    </Suspense>
  );
}
