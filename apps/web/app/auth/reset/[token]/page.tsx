'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { authEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Button, Field, Input } from '@castlane/ui';
import { AuthCard, FormError } from '@/components/auth/auth-card';
import { api } from '@/lib/api';

export default function ResetPage() {
  const { token } = useParams<{ token: string }>();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const mismatch = pw2.length > 0 && pw !== pw2;
  return (
    <AuthCard title="Choose a new password" description="Use at least 12 characters. Spaces and password managers are welcome.">
      {done ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="rounded-[8px] bg-selection px-3 py-2 text-[14px] text-fg">
            Your password was changed and all other sessions were signed out.
          </p>
          <Link href="/auth/sign-in" className="text-[14px] font-semibold text-primary hover:underline">
            Continue to Sign In
          </Link>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (mismatch) return;
            setPending(true);
            setError(null);
            try {
              await api.call(authEndpoints.reset, { body: { token, newPassword: pw } });
              setDone(true);
            } catch (err) {
              setError(isApiError(err) ? (err.fieldErrors[0]?.message ?? err.message) : 'The password could not be changed.');
            } finally {
              setPending(false);
            }
          }}
        >
          <FormError message={error} />
          <Field label="New Password" required helper="12–128 characters.">
            <Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={12} maxLength={128} />
          </Field>
          <Field label="Confirm Password" required error={mismatch ? 'The passwords do not match.' : null}>
            <Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" loading={pending} disabled={pw.length < 12 || pw !== pw2}>
            Reset Password
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
