'use client';
import { useState } from 'react';
import { authEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Banner, Button, Field, Input } from '@castlane/ui';
import { api } from '@/lib/api';

export const isRecentAuthError = (e: unknown) => isApiError(e) && e.code === 'RECENT_AUTH_REQUIRED';

/**
 * Inline recent-authentication step for critical actions: confirm the password (and the
 * verification code when two-step verification is on), then retry the action.
 */
export const ReauthForm = ({ onConfirmed, onCancel }: { onConfirmed: () => void | Promise<void>; onCancel: () => void }) => {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.call(authEndpoints.reauthenticate, { body: { password, code: code.trim() || undefined } });
      await onConfirmed();
    } catch (e) {
      setError(isApiError(e) ? e.message : 'Could not confirm your identity. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-[13px] text-fg">Confirm it is you. This action needs a recent sign-in confirmation.</p>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Field label="Password" required>
        <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="Verification code" helper="Only if you use two-step verification.">
        <Input inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!password}>
          Confirm and Continue
        </Button>
      </div>
    </form>
  );
};
