'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { authEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Button, Field, Input } from '@castlane/ui';
import { AuthCard, FormError } from '@/components/auth/auth-card';
import { api } from '@/lib/api';
import { saveChallenge } from '@/lib/challenge';

export const SignInForm = () => {
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(params.get('expired') ? 'Your session has ended. Sign in again to continue.' : null);
  const [pending, setPending] = useState(false);
  const returnTo = params.get('returnTo') ?? undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const r = await api.call(authEndpoints.signIn, { body: { email, password, returnTo } });
      if (r.status === 'signed_in') window.location.assign(r.redirectTo);
      else {
        saveChallenge({ id: r.challengeId, kind: r.status === 'mfa_required' ? 'verify' : 'setup' });
        window.location.assign(`/auth/mfa${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`);
      }
    } catch (err) {
      setError(
        isApiError(err)
          ? err.code === 'RATE_LIMITED'
            ? `Too many attempts. Try again in ${Math.ceil((err.retryAfterSeconds ?? 60) / 60)} minute(s).`
            : err.message
          : 'Sign-in failed. Check your connection and try again.',
      );
      setPending(false);
    }
  };

  return (
    <AuthCard title="Sign in" description="Castlane CRM — your team workspace.">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <FormError message={error} />
        <Field label="Email" required>
          <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" required>
          <Input type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 text-[13px] text-fg-2">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password
          </label>
          <Link href="/auth/recovery" className="text-[13px] font-medium text-primary hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" variant="primary" loading={pending} disabled={!email || !password}>
          Sign In
        </Button>
      </form>
    </AuthCard>
  );
};
