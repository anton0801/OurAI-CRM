'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Button, Field, Input } from '@castlane/ui';
import { AuthCard, FormError } from '@/components/auth/auth-card';
import { api } from '@/lib/api';
import { saveChallenge } from '@/lib/challenge';

export default function AcceptInvitationPage() {
  const { token } = useParams<{ token: string }>();
  const info = useQuery({ queryKey: ['invitation', token], queryFn: () => api.call(authEndpoints.invitationInfo, { params: { token } }), retry: false });
  const [displayName, setDisplayName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);

  if (info.isLoading) return <AuthCard title="Invitation">Checking the invitation…</AuthCard>;
  const d = info.data;
  if (!d || d.status === 'revoked')
    return (
      <AuthCard title="Invitation not valid" description="This invitation link was revoked or replaced. Ask the person who invited you for a new invitation.">
        <Link href="/auth/sign-in" className="text-[14px] font-semibold text-primary hover:underline">Back to Sign In</Link>
      </AuthCard>
    );
  if (d.status === 'expired')
    return (
      <AuthCard title="Invitation expired" description={`The invitation to ${d.workspaceName ?? 'the workspace'} has expired.`}>
        {requested ? (
          <p role="status" className="rounded-[8px] bg-selection px-3 py-2 text-[14px] text-fg">
            Your request was sent to the workspace administrators.
          </p>
        ) : (
          <Button
            variant="primary"
            loading={pending}
            onClick={async () => {
              setPending(true);
              try {
                await api.call(authEndpoints.requestNewInvitation, { body: { token } });
                setRequested(true);
              } finally {
                setPending(false);
              }
            }}
          >
            Request New Invitation
          </Button>
        )}
      </AuthCard>
    );
  if (d.status === 'accepted' && !d.existingAccount)
    return (
      <AuthCard title="Invitation already used">
        <Link href="/auth/sign-in" className="text-[14px] font-semibold text-primary hover:underline">Sign In</Link>
      </AuthCard>
    );

  const existing = d.existingAccount;
  const mismatch = !existing && pw2.length > 0 && pw !== pw2;
  return (
    <AuthCard
      title={`Join ${d.workspaceName ?? 'the workspace'}`}
      description={
        <>
          <span>Invited e-mail: </span>
          <strong className="text-fg">{d.email}</strong>
          {d.accessSummary.length ? <ul className="mt-2 list-disc pl-5 text-[13px]">{d.accessSummary.map((a) => <li key={a}>{a}</li>)}</ul> : null}
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (mismatch) return;
          setPending(true);
          setError(null);
          try {
            const r = await api.call(authEndpoints.acceptInvitation, { body: { token, password: pw, displayName: existing ? undefined : displayName } });
            if (r.status === 'signed_in') window.location.assign(r.redirectTo);
            else {
              saveChallenge({ id: r.challengeId, kind: r.status === 'mfa_required' ? 'verify' : 'setup' });
              window.location.assign('/auth/mfa');
            }
          } catch (err) {
            setError(isApiError(err) ? (err.fieldErrors[0]?.message ?? err.message) : 'The invitation could not be accepted.');
            setPending(false);
          }
        }}
      >
        <FormError message={error} />
        {existing ? (
          <p className="text-[13px] text-fg-2">An account already exists for this e-mail. Enter its password to accept.</p>
        ) : (
          <Field label="Display Name" required helper="2–80 characters.">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" maxLength={80} />
          </Field>
        )}
        <Field label="Password" required helper={existing ? undefined : 'At least 12 characters.'}>
          <Input type="password" autoComplete={existing ? 'current-password' : 'new-password'} value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        {!existing ? (
          <Field label="Confirm Password" required error={mismatch ? 'The passwords do not match.' : null}>
            <Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </Field>
        ) : null}
        <Button type="submit" variant="primary" loading={pending} disabled={!pw || (!existing && (displayName.trim().length < 2 || pw.length < 12 || pw !== pw2))}>
          Accept Invitation
        </Button>
      </form>
    </AuthCard>
  );
}
