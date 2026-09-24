'use client';
import { Plus, Trash } from '@phosphor-icons/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { setupEndpoints } from '@castlane/api-contracts';
import { Button, Field, IconButton, Input, Panel, Select, Skeleton } from '@castlane/ui';
import { FormError } from '@/components/auth/auth-card';
import { SetupStepHeader } from '@/components/setup/setup-frame';
import { useApiMutation, useApiQuery } from '@/lib/hooks';

interface Row {
  key: string;
  id?: string;
  name: string;
  leadMembershipId: string | null;
  presetKind: 'series' | 'model' | 'influencer' | null;
}

const DEFAULTS: Row[] = [
  { key: 'a', name: 'AI Series', leadMembershipId: null, presetKind: 'series' },
  { key: 'b', name: 'AI Models', leadMembershipId: null, presetKind: 'model' },
  { key: 'c', name: 'AI Influencers', leadMembershipId: null, presetKind: 'influencer' },
];

const DirectionsStep = () => {
  const router = useRouter();
  const w = useSearchParams().get('w') ?? '';
  const progress = useApiQuery(setupEndpoints.progress, { params: { workspaceId: w } }, { enabled: !!w });
  const [rows, setRows] = useState<Row[]>(DEFAULTS);
  const loaded = useRef(false);
  // The form renders only after the saved progress is applied, so nothing typed is overwritten.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const d = progress.data?.directions;
    if (!d || loaded.current) return;
    loaded.current = true;
    setReady(true);
    if (d.length) setRows(d.map((x) => ({ key: x.id, id: x.id, name: x.name, leadMembershipId: x.leadMembershipId, presetKind: (x.presetKind as Row['presetKind']) ?? null })));
  }, [progress.data]);
  const save = useApiMutation(setupEndpoints.saveDirections, { silentErrors: true });
  const names = rows.map((r) => r.name.trim().toLowerCase());
  const dup = names.some((n, i) => n && names.indexOf(n) !== i);
  const invalid = rows.length === 0 || rows.some((r) => r.name.trim().length < 2) || dup;
  const members = (progress.data?.members ?? []).map((m) => ({ value: m.id, label: m.displayName }));
  if (progress.isError) return <FormError message={progress.error.message} />;
  if (!ready)
    return (
      <Panel>
        <div aria-busy="true" aria-label="Loading" className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </Panel>
    );
  return (
    <>
      <SetupStepHeader
        step={2}
        title="Create your directions"
        description="Directions organise projects and their leads. OFM is an operations module available inside Model and Influencer projects — it does not create separate models."
      />
      <Panel>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await save.run({ params: { workspaceId: w }, body: { directions: rows.map((r) => ({ id: r.id, name: r.name.trim(), leadMembershipId: r.leadMembershipId, presetKind: r.presetKind })) } });
              router.push(`/setup/team?w=${w}`);
            } catch {
              /* shown below */
            }
          }}
        >
          <FormError message={save.error?.message ?? (dup ? 'Direction names must be unique.' : null)} />
          <ul className="flex flex-col gap-3">
            {rows.map((r, i) => (
              <li key={r.key} className="grid grid-cols-1 items-end gap-3 rounded-[8px] border border-line p-3 sm:grid-cols-[1fr_220px_auto]">
                <Field label="Name" required>
                  <Input value={r.name} maxLength={120} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                </Field>
                <Field label="Lead">
                  <Select
                    value={r.leadMembershipId}
                    onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, leadMembershipId: v } : x)))}
                    options={members}
                    placeholder="Optional"
                    clearable
                  />
                </Field>
                <IconButton
                  label={r.id ? 'Remove direction' : 'Remove unsaved direction'}
                  icon={<Trash size={16} />}
                  disabled={rows.length === 1}
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                />
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap justify-between gap-2">
            <Button icon={<Plus size={14} />} onClick={() => setRows([...rows, { key: crypto.randomUUID(), name: '', leadMembershipId: null, presetKind: null }])}>
              Add Direction
            </Button>
            <div className="flex gap-2">
              <Button onClick={() => router.push(`/setup/workspace?w=${w}`)}>Back</Button>
              <Button type="submit" variant="primary" loading={save.isPending} disabled={invalid}>
                Save and Continue
              </Button>
            </div>
          </div>
        </form>
      </Panel>
    </>
  );
};

export default function Page() {
  return (
    <Suspense>
      <DirectionsStep />
    </Suspense>
  );
}
