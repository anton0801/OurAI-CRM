'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { authEndpoints, settingsEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Button } from '@castlane/ui';
import { AuthCard, FormError } from '@/components/auth/auth-card';
import { api, setCsrfToken } from '@/lib/api';

/**
 * Confirmation link sent to the new address. Nothing changes until the button is pressed, so mail
 * scanners that prefetch links cannot confirm the change.
 */
export default function EmailChangeConfirmPage() {
  const { token } = useParams<{ token: string }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  return (
    <AuthCard title="Confirm your new e-mail" description="Confirm that this address should be used to sign in to Castlane.">
      {email ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="rounded-[8px] bg-selection px-3 py-2 text-[14px] text-fg">
            Your e-mail is now {email}. Use it the next time you sign in.
          </p>
          <Link href="/" className="text-[14px] font-semibold text-primary hover:underline">
            Continue to Castlane
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <FormError message={error} />
          <Button
            variant="primary"
            loading={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                // A signed-in browser must send its session-bound security token; otherwise the pre-session one is used.
                try {
                  const me = await api.call(authEndpoints.me, {});
                  setCsrfToken(me.csrfToken);
                } catch {
                  setCsrfToken(null);
                }
                const r = await api.call(settingsEndpoints.confirmEmailChange, { body: { token } });
                setEmail(r.email);
              } catch (e) {
                setError(isApiError(e) ? e.message : 'The address could not be confirmed. Try again.');
              } finally {
                setPending(false);
              }
            }}
          >
            Confirm New E-mail
          </Button>
          <Link href="/auth/sign-in" className="text-center text-[13px] text-fg-2 hover:underline">
            Back to Sign In
          </Link>
        </div>
      )}
    </AuthCard>
  );
}
