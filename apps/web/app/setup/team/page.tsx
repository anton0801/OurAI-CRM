'use client';
import { Plus, Trash } from '@phosphor-icons/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { setupEndpoints } from '@castlane/api-contracts';
import type { ScopeType } from '@castlane/domain';
import { Badge, Button, Field, IconButton, Input, Panel, Select } from '@castlane/ui';
import { FormError } from '@/components/auth/auth-card';
import { SetupStepHeader } from '@/components/setup/setup-frame';
import { useApiMutation, useApiQuery } from '@/lib/hooks';

interface Row {
  key: string;
  email: string;
  roleId: string | null;
  scope: string | null;
}

const OUTCOME_TEXT: Record<string, string> = {
  queued: 'Invitation queued for delivery',
  resent: 'Previous invitation replaced and re-sent',
  already_member: 'Already a member',
  invalid_role: 'Role not allowed',
  invalid_scope: 'Scope not valid',
};

const TeamStep = () => {
  const router = useRouter();
  const w = useSearchParams().get('w') ?? '';
  const progress = useApiQuery(setupEndpoints.progress, { params: { workspaceId: w } }, { enabled: !!w });
  const [rows, setRows] = useState<Row[]>([{ key: 'r0', email: '', roleId: null, scope: 'workspace' }]);
  const [results, setResults] = useState<{ email: string; outcome: string }[] | null>(null);
  const invite = useApiMutation(setupEndpoints.inviteTeam, { silentErrors: true });
  const roles = progress.data?.roles ?? [];
  const roleOptions = roles.filter((r) => r.key !== 'owner').map((r) => ({ value: r.id, label: r.name, description: `Default scope: ${r.defaultScopeType.replace(/_/g, ' ')}` }));
  const scopeOptions = useMemo(
    () => [
      { value: 'workspace', label: 'Whole workspace' },
      { value: 'assigned_projects', label: 'Projects they are assigned to' },
      { value: 'assigned_accounts', label: 'Accounts they are assigned to' },
      { value: 'assigned_object', label: 'Only items assigned to them' },
      ...(progress.data?.directions ?? []).map((d) => ({ value: `direction:${d.id}`, label: `Direction: ${d.name}` })),
    ],
    [progress.data],
  );
  const toGrant = (r: Row) => {
    const [type, id] = (r.scope ?? 'workspace').split(':');
    return { email: r.email.trim(), roleId: r.roleId!, scopeType: type as ScopeType, scopeId: id ?? null };
  };
  const filled = rows.filter((r) => r.email.trim());
  const valid = filled.every((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email.trim()) && r.roleId && r.scope);
  const preview = (roleId: string | null) => roles.find((r) => r.id === roleId)?.permissions.length ?? 0;

  const submit = async (finish: boolean, send: boolean) => {
    try {
      const r = await invite.run({ params: { workspaceId: w }, body: { invitations: send ? filled.map(toGrant) : [], finish } });
      if (send) setResults(r.results);
      if (finish) router.push(`/w/${w}/overview`);
    } catch {
      /* shown below */
    }
  };

  return (
    <>
      <SetupStepHeader step={3} title="Invite your team" description="Invite up to 20 people now, or later from Team. The Owner role is never granted through an invitation." />
      <Panel>
        <div className="flex flex-col gap-4">
          <FormError message={invite.error?.message ?? null} />
          <ul className="flex flex-col gap-3">
            {rows.map((r, i) => (
              <li key={r.key} className="grid grid-cols-1 items-end gap-3 rounded-[8px] border border-line p-3 md:grid-cols-[1.3fr_1fr_1fr_auto]">
                <Field label="Email" required>
                  <Input type="email" value={r.email} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} />
                </Field>
                <Field label="Role" required helper={r.roleId ? `${preview(r.roleId)} permissions` : undefined}>
                  <Select value={r.roleId} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, roleId: v } : x)))} options={roleOptions} />
                </Field>
                <Field label="Scope" required>
                  <Select value={r.scope} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, scope: v } : x)))} options={scopeOptions} />
                </Field>
                <IconButton label="Remove row" icon={<Trash size={16} />} disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))} />
              </li>
            ))}
          </ul>
          <Button icon={<Plus size={14} />} disabled={rows.length >= 20} onClick={() => setRows([...rows, { key: crypto.randomUUID(), email: '', roleId: null, scope: 'workspace' }])}>
            Add Row
          </Button>
          {results ? (
            <ul className="flex flex-col gap-1 rounded-[8px] bg-surface-2 p-3" aria-live="polite">
              {results.map((r) => (
                <li key={r.email} className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="truncate text-fg">{r.email}</span>
                  <Badge tone={r.outcome === 'queued' || r.outcome === 'resent' ? 'success' : 'warning'}>{OUTCOME_TEXT[r.outcome] ?? r.outcome}</Badge>
                </li>
              ))}
              <li className="mt-1 text-[12px] text-fg-2">Delivery status is tracked separately in Team → Invitations.</li>
            </ul>
          ) : null}
          <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-4">
            <Button onClick={() => router.push(`/setup/directions?w=${w}`)}>Back</Button>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void submit(true, false)} loading={invite.isPending && filled.length === 0}>
                Invite Later
              </Button>
              <Button onClick={() => void submit(false, true)} disabled={filled.length === 0 || !valid} loading={invite.isPending}>
                Send Invitations
              </Button>
              <Button variant="primary" onClick={() => void submit(true, false)} loading={invite.isPending}>
                Finish Setup
              </Button>
            </div>
          </div>
        </div>
      </Panel>
    </>
  );
};

export default function Page() {
  return (
    <Suspense>
      <TeamStep />
    </Suspense>
  );
}
