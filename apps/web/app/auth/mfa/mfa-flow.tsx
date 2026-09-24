'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { authEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Button, Field, Input } from '@castlane/ui';
import { AuthCard, FormError } from '@/components/auth/auth-card';
import { api, setCsrfToken } from '@/lib/api';
import { clearChallenge, readChallenge } from '@/lib/challenge';

type Stage =
  | { k: 'loading' }
  | { k: 'verify'; challengeId: string }
  | { k: 'reauth' }
  | { k: 'setup'; challengeId: string; secret: string; qrSvg: string }
  | { k: 'codes'; codes: string[]; redirectTo: string }
  | { k: 'missing' };

export const MfaFlow = () => {
  const params = useSearchParams();
  const returnTo = params.get('returnTo');
  const [stage, setStage] = useState<Stage>({ k: 'loading' });
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const startSetup = async (challengeId?: string) => {
    const r = await api.call(authEndpoints.mfaSetupStart, { body: { challengeId } });
    setStage({ k: 'setup', challengeId: r.challengeId, secret: r.secret, qrSvg: r.qrSvg });
  };

  useEffect(() => {
    const c = readChallenge();
    if (params.get('mode') === 'session') {
      // Signed in, but the role now requires MFA: confirm the password, then set it up.
      api
        .call(authEndpoints.me, {})
        .then((me) => {
          setCsrfToken(me.csrfToken);
          setStage({ k: 'reauth' });
        })
        .catch(() => setStage({ k: 'missing' }));
      return;
    }
    if (!c) return setStage({ k: 'missing' });
    if (c.kind === 'verify') setStage({ k: 'verify', challengeId: c.id });
    else startSetup(c.id).catch((e) => {
      setError(isApiError(e) ? e.message : 'Could not start the setup.');
      setStage({ k: 'missing' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fail = (e: unknown) => {
    setError(isApiError(e) ? e.message : 'Something went wrong. Try again.');
    setPending(false);
  };

  if (stage.k === 'loading') return <AuthCard title="Two-factor authentication">Loading…</AuthCard>;
  if (stage.k === 'missing')
    return (
      <AuthCard title="Verification step expired" description="For your security this step is only valid for a few minutes.">
        <FormError message={error} />
        <Link href="/auth/sign-in" className="mt-4 inline-block text-[14px] font-semibold text-primary hover:underline">
          Back to Sign In
        </Link>
      </AuthCard>
    );

  if (stage.k === 'verify')
    return (
      <AuthCard
        title="Enter verification code"
        description={useRecovery ? 'Enter one of your one-time recovery codes.' : 'Open your authenticator app and enter the 6-digit code.'}
        footer={<Link href="/auth/sign-in" className="font-medium text-primary hover:underline">Back to Sign In</Link>}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (pending) return;
            setPending(true);
            setError(null);
            try {
              const r = await api.call(authEndpoints.mfaVerify, { body: { challengeId: stage.challengeId, code, kind: useRecovery ? 'recovery' : 'totp' } });
              clearChallenge();
              window.location.assign(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : r.redirectTo);
            } catch (err) {
              fail(err);
            }
          }}
        >
          <FormError message={error} />
          <Field label={useRecovery ? 'Recovery Code' : 'Verification Code'} required>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode={useRecovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              maxLength={useRecovery ? 32 : 6}
              autoFocus
            />
          </Field>
          <Button type="submit" variant="primary" loading={pending} disabled={code.trim().length < 6}>
            Verify
          </Button>
          <button type="button" className="text-[13px] font-medium text-primary hover:underline" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(null); }}>
            {useRecovery ? 'Use authenticator code' : 'Use Recovery Code'}
          </button>
        </form>
      </AuthCard>
    );

  if (stage.k === 'reauth')
    return (
      <AuthCard title="Set up two-factor authentication" description="Your role requires two-factor authentication. Confirm your password to begin.">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            setError(null);
            try {
              await api.call(authEndpoints.reauthenticate, { body: { password } });
              await startSetup();
              setPending(false);
            } catch (err) {
              fail(err);
            }
          }}
        >
          <FormError message={error} />
          <Field label="Password" required>
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" loading={pending} disabled={!password}>
            Continue
          </Button>
        </form>
      </AuthCard>
    );

  if (stage.k === 'setup')
    return (
      <AuthCard title="Set up two-factor authentication" description="Scan the QR code with an authenticator app, then enter the 6-digit code it shows.">
        <div className="flex flex-col items-center gap-3">
          <div className="h-[192px] w-[192px] rounded-[8px] bg-white p-1" aria-label="QR code for your authenticator app" role="img" dangerouslySetInnerHTML={{ __html: stage.qrSvg }} />
          <div className="w-full">
            <p className="text-[12px] font-[550] text-fg">Or enter this key manually</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 break-all rounded-[8px] bg-surface-2 px-2 py-1.5 font-mono text-[13px] text-fg">{stage.secret}</code>
              <Button size="sm" onClick={() => void navigator.clipboard?.writeText(stage.secret)}>
                Copy
              </Button>
            </div>
          </div>
        </div>
        <form
          className="mt-5 flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            setError(null);
            try {
              const r = await api.call(authEndpoints.mfaSetupConfirm, { body: { challengeId: stage.challengeId, code } });
              clearChallenge();
              setStage({ k: 'codes', codes: r.recoveryCodes, redirectTo: returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : r.redirectTo });
              setPending(false);
            } catch (err) {
              fail(err);
            }
          }}
        >
          <FormError message={error} />
          <Field label="Verification Code" required>
            <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} />
          </Field>
          <Button type="submit" variant="primary" loading={pending} disabled={code.length !== 6}>
            Verify and Enable
          </Button>
        </form>
      </AuthCard>
    );

  return (
    <AuthCard title="Save your recovery codes" description="Each code works once if you lose access to your authenticator. They are shown only now.">
      <ul className="grid grid-cols-2 gap-2 rounded-[8px] bg-surface-2 p-3 font-mono text-[14px] text-fg">
        {stage.codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="mt-4 flex flex-col gap-2">
        <Button onClick={() => void navigator.clipboard?.writeText(stage.codes.join('\n'))}>Copy Codes</Button>
        <Button variant="primary" onClick={() => window.location.assign(stage.redirectTo)}>
          I Saved the Codes — Continue
        </Button>
      </div>
    </AuthCard>
  );
};
