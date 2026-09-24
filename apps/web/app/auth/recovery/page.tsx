'use client';
import Link from 'next/link';
import { useState } from 'react';
import { authEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Button, Field, Input } from '@castlane/ui';
import { AuthCard, FormError } from '@/components/auth/auth-card';
import { api } from '@/lib/api';

export default function RecoveryPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <AuthCard
      title="Reset your password"
      description="Enter the e-mail address of your account."
      footer={<Link href="/auth/sign-in" className="font-medium text-primary hover:underline">Back to Sign In</Link>}
    >
      {sent ? (
        <p role="status" className="rounded-[8px] bg-selection px-3 py-2 text-[14px] text-fg">
          {sent}
        </p>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            setError(null);
            try {
              const r = await api.call(authEndpoints.recovery, { body: { email } });
              setSent(r.message);
            } catch (err) {
              setError(isApiError(err) ? err.message : 'The request could not be sent. Try again.');
            } finally {
              setPending(false);
            }
          }}
        >
          <FormError message={error} />
          <Field label="Email" required>
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" loading={pending} disabled={!email}>
            Send Reset Link
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
