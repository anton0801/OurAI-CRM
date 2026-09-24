'use client';
import { useState } from 'react';
import { teamEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { isEmail } from '@castlane/domain';
import { Banner, Button, Drawer, Field, Input, toast } from '@castlane/ui';
import { useApiMutation } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';
import { draftComplete, GrantEditor, newGrantDraft, toGrantInput, type GrantDraft } from './grant-editor';

/**
 * Invite drawer (S61): e-mail plus role/scope grants. The server validates the grants against the
 * inviter's own rights; delivery status is tracked separately from acceptance.
 */
export const InviteDrawer = ({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [email, setEmail] = useState('');
  const [grants, setGrants] = useState<GrantDraft[]>([newGrantDraft()]);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invite = useApiMutation(teamEndpoints.invite, { invalidate: ['team.'], silentErrors: true });
  const dirty = email.trim().length > 0 || grants.some((g) => g.roleId);
  const reset = () => {
    setEmail('');
    setGrants([newGrantDraft()]);
    setEmailError(null);
    setGrantError(null);
    setError(null);
  };
  const submit = async () => {
    setError(null);
    setEmailError(null);
    setGrantError(null);
    if (!isEmail(email.trim().toLowerCase())) return setEmailError('Enter a valid e-mail address.');
    if (!grants.every(draftComplete)) return setGrantError('Choose a role and a complete scope for every row.');
    try {
      const r = await invite.run({ params: { workspaceId: workspace.id }, body: { email: email.trim(), grants: grants.map(toGrantInput) } });
      toast.success(r.outcome === 'resent' ? 'Invitation replaced and re-sent' : 'Invitation queued', r.message);
      reset();
      onOpenChange(false);
    } catch (e) {
      if (!isApiError(e)) return setError('The invitation could not be sent.');
      const f = e.fieldErrors.find((x) => x.field === 'email');
      if (f) setEmailError(f.message);
      else if (e.fieldErrors.some((x) => x.field.startsWith('grants'))) setGrantError(e.fieldErrors[0]!.message);
      else setError(e.network ? 'You are offline. Changes are not being saved.' : e.message);
    }
  };
  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      dirty={dirty}
      title="Invite to the workspace"
      description="The invitation link is valid for 72 hours and can be used once."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={invite.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={invite.isPending} onClick={() => void submit()}>
            Send Invitation
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Email" required error={emailError}>
          <Input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} />
        </Field>
        <div className="flex flex-col gap-2">
          <h3 className="text-[14px] font-semibold text-fg">Access</h3>
          <p className="text-[12px] text-fg-2">Roles apply within the chosen scope. The Owner role is never granted through an invitation; only the Owner grants Admin and finance roles.</p>
          <GrantEditor value={grants} onChange={setGrants} error={grantError} />
        </div>
      </div>
    </Drawer>
  );
};
