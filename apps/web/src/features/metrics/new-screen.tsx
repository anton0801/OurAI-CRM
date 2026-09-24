'use client';
import { useRouter } from 'next/navigation';
import { PageHeader, PermissionDenied, TabPanel, Tabs, toast } from '@castlane/ui';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWsPath } from '@/lib/workspace-context';
import { BulkEntry } from './bulk-entry';
import { ObservationForm } from './entry-form';

type Keys = 'mode' | 'accountId' | 'publicationId' | 'checkpointId' | 'entityType' | 'observedAt';

/** S50 Add Metrics: a single observation (optionally for a checkpoint) or the Bulk Entry grid. */
export const NewMetricsScreen = () => {
  const can = useCan();
  const router = useRouter();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<Keys>({ mode: 'single' });
  if (!can('metrics.write')) return <PermissionDenied description="You can view metrics but not record them." />;
  const entityType = state.publicationId ? 'publication' : state.entityType === 'ofm_account' ? 'ofm_account' : 'account';
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Metrics', href: wsPath('/metrics') }, { label: 'Add Metrics' }]}
        title="Add Metrics"
        description="Record values exactly as the source reports them, with the real time you read them. Account links do not import statistics or publish content."
      />
      <Tabs
        label="Entry mode"
        value={state.mode === 'bulk' ? 'bulk' : 'single'}
        onValueChange={(v) => set({ mode: v })}
        items={[
          { value: 'single', label: 'Single Entry' },
          { value: 'bulk', label: 'Bulk Entry', hidden: !!state.checkpointId },
        ]}
      >
        <TabPanel value="single">
          <ObservationForm
            initial={{ entityType, entityId: state.publicationId ?? state.accountId ?? null, checkpointId: state.checkpointId ?? null, observedAt: state.observedAt ?? null }}
            onSaved={(o) => {
              toast.success('Metrics saved');
              router.push(wsPath(`/metrics/${o.id}`));
            }}
            onCancel={() => router.back()}
          />
        </TabPanel>
        <TabPanel value="bulk">
          <BulkEntry />
        </TabPanel>
      </Tabs>
    </div>
  );
};
