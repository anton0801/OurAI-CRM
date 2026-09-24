'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { setupEndpoints } from '@castlane/api-contracts';
import { SUPPORTED_CURRENCIES } from '@castlane/domain';
import { Button, Field, Input, Panel, Select } from '@castlane/ui';
import { FormError } from '@/components/auth/auth-card';
import { SetupStepHeader } from '@/components/setup/setup-frame';
import { useApiMutation, useApiQuery } from '@/lib/hooks';

const zones = (): string[] => {
  let list: string[] = [];
  try {
    list = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    list = [];
  }
  return list.includes('UTC') ? list : ['UTC', ...list];
};

const WorkspaceStep = () => {
  const router = useRouter();
  const w = useSearchParams().get('w') ?? '';
  const progress = useApiQuery(setupEndpoints.progress, { params: { workspaceId: w } }, { enabled: !!w });
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>('EUR');
  const [weekStartsOn, setWeek] = useState<'monday' | 'sunday'>('monday');
  const suggested = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const loaded = useRef(false);
  useEffect(() => {
    const d = progress.data?.workspace;
    // Initialise the form once; later refetches must not overwrite what the Owner is typing.
    if (!d || loaded.current) return;
    loaded.current = true;
    setName(d.name === 'Castlane Workspace' ? '' : d.name);
    setTimezone(d.timezone === 'UTC' && suggested ? suggested : d.timezone);
    setCurrency(d.baseCurrency);
    setWeek(d.weekStartsOn);
  }, [progress.data, suggested]);
  const save = useApiMutation(setupEndpoints.saveWorkspace, { silentErrors: true });
  const tzOptions = useMemo(() => zones().map((z) => ({ value: z, label: z })), []);
  if (!w) return <FormError message="Missing workspace. Open the setup link from your sign-in page." />;
  return (
    <>
      <SetupStepHeader step={1} title="Set up your workspace" description="Name, time zone and base currency. Nothing financial is created by choosing a currency." />
      <Panel>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await save.run({ params: { workspaceId: w }, body: { name, timezone: timezone ?? 'UTC', baseCurrency: currency ?? 'EUR', weekStartsOn } });
              router.push(`/setup/directions?w=${w}`);
            } catch {
              /* shown below */
            }
          }}
        >
          <FormError message={save.error?.message ?? null} />
          <Field label="Name" required helper="2–80 characters.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Castlane Studio" />
          </Field>
          <Field label="Timezone" required helper={suggested && timezone === suggested ? `Suggested from your browser: ${suggested}. Confirm or change it.` : undefined}>
            <Select value={timezone} onChange={setTimezone} options={tzOptions} placeholder="Choose a time zone" />
          </Field>
          <Field
            label="Base Currency"
            required
            helper={progress.data?.workspace.baseCurrencyLocked ? 'Locked after the first posted financial entry.' : 'Can be changed until the first financial entry is posted.'}
          >
            <Select
              value={currency}
              onChange={setCurrency}
              disabled={progress.data?.workspace.baseCurrencyLocked}
              options={SUPPORTED_CURRENCIES.map((c) => ({ value: c, label: c }))}
            />
          </Field>
          <Field label="Week Starts On">
            <Select value={weekStartsOn} onChange={(v) => setWeek((v ?? 'monday') as 'monday' | 'sunday')} options={[{ value: 'monday', label: 'Monday' }, { value: 'sunday', label: 'Sunday' }]} />
          </Field>
          <p className="text-[12px] text-fg-2">A logo can be added later in Workspace Settings.</p>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={save.isPending} disabled={name.trim().length < 2 || !timezone || !currency}>
              Save and Continue
            </Button>
          </div>
        </form>
      </Panel>
    </>
  );
};

export default function Page() {
  return (
    <Suspense>
      <WorkspaceStep />
    </Suspense>
  );
}
