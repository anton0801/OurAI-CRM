'use client';
import { useState } from 'react';
import { contentEndpoints, type EndpointResponse } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Badge, Banner, Button, Dialog, Field, Input, RadioGroup, Select } from '@castlane/ui';
import { MemberSelect } from '@/components/common/pickers';
import { useApiMutation } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';

type Action = 'assign_owner' | 'assign_reviewer' | 'add_tag' | 'remove_tag' | 'move_stage';
type Preview = EndpointResponse<typeof contentEndpoints.bulkPreview>;
type Result = EndpointResponse<typeof contentEndpoints.bulkApply>;

const ACTIONS: { value: Action; label: string }[] = [
  { value: 'assign_owner', label: 'Assign Owner' },
  { value: 'assign_reviewer', label: 'Assign Reviewer' },
  { value: 'add_tag', label: 'Add Tag' },
  { value: 'remove_tag', label: 'Remove Tag' },
  { value: 'move_stage', label: 'Move to Stage' },
];
const MOVABLE = ['brief', 'ready', 'production'] as const;
const OUTCOME_TONE = { apply: 'success', skip: 'neutral', denied: 'danger', conflict: 'warning' } as const;
const OUTCOME_LABEL = {
  apply: 'Will change',
  skip: 'No change',
  denied: 'Not allowed',
  conflict: 'Conflict',
} as const;

/** Bulk Assign / Tag / Move (S22): preview of every item first, then per-item application. */
export const BulkContentDialog = ({
  open,
  onOpenChange,
  ids,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  ids: string[];
  onDone: () => void;
}) => {
  const { workspace } = useWorkspace();
  const [action, setAction] = useState<Action>('assign_owner');
  const [value, setValue] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewM = useApiMutation(contentEndpoints.bulkPreview, { silentErrors: true });
  const applyM = useApiMutation(contentEndpoints.bulkApply, { invalidate: ['content.'], silentErrors: true });
  const reset = () => {
    setPreview(null);
    setResult(null);
    setError(null);
  };
  const close = (o: boolean) => {
    if (!o) {
      reset();
      setValue(null);
    }
    onOpenChange(o);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={`Bulk action on ${ids.length} item${ids.length === 1 ? '' : 's'}`}
      description="Review changes before applying. Nothing has been changed yet."
      size="regular"
      footer={
        result ? (
          <Button variant="primary" onClick={() => close(false)}>
            Done
          </Button>
        ) : preview ? (
          <>
            <Button onClick={reset}>Back</Button>
            <Button
              variant="primary"
              loading={applyM.isPending}
              disabled={preview.applyCount === 0}
              onClick={async () => {
                setError(null);
                try {
                  const r = await applyM.run({
                    params: { workspaceId: workspace.id },
                    body: { token: preview.token },
                  });
                  setResult(r);
                  onDone();
                } catch (e) {
                  setError(isApiError(e) ? e.message : 'The bulk action could not be applied.');
                }
              }}
            >
              Apply to {preview.applyCount} item{preview.applyCount === 1 ? '' : 's'}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={previewM.isPending}
              disabled={!value?.trim()}
              onClick={async () => {
                setError(null);
                try {
                  setPreview(
                    await previewM.run({
                      params: { workspaceId: workspace.id },
                      body: { action, ids, value: value!.trim() },
                    }),
                  );
                } catch (e) {
                  setError(
                    isApiError(e)
                      ? (e.fieldErrors[0]?.message ?? e.message)
                      : 'The preview could not be created.',
                  );
                }
              }}
            >
              Preview Changes
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {result ? (
          <div className="flex flex-col gap-2 text-[14px]">
            <p>
              {result.done.length} item{result.done.length === 1 ? '' : 's'} changed
              {result.failed.length ? `, ${result.failed.length} not changed` : ''}.
            </p>
            {result.warnings.map((w) => (
              <Banner key={w} tone="warning">
                {w}
              </Banner>
            ))}
            {result.failed.length ? (
              <ul className="flex flex-col gap-1 text-[13px] text-fg-2">
                {result.failed.map((f) => (
                  <li key={f.id}>
                    {preview?.items.find((i) => i.id === f.id)?.title ?? 'Item'}: {f.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : preview ? (
          <>
            {preview.missingCount ? (
              <Banner tone="info">
                {preview.missingCount} selected item(s) are no longer available to you and are skipped.
              </Banner>
            ) : null}
            <ul className="flex max-h-[360px] flex-col divide-y divide-line overflow-y-auto rounded-[8px] border border-line">
              {preview.items.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[13px]"
                >
                  <span className="min-w-0 flex-1 truncate">{i.title}</span>
                  <span className="flex items-center gap-2">
                    {i.reason ? <span className="text-fg-2">{i.reason}</span> : null}
                    <Badge tone={OUTCOME_TONE[i.outcome]}>{OUTCOME_LABEL[i.outcome]}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <RadioGroup
              label="Action"
              value={action}
              onValueChange={(v) => {
                setAction(v);
                setValue(null);
              }}
              options={ACTIONS}
            />
            {action === 'assign_owner' || action === 'assign_reviewer' ? (
              <Field
                label={action === 'assign_owner' ? 'New owner' : 'New reviewer'}
                required
                helper={
                  action === 'assign_reviewer'
                    ? 'Only members with approval rights in each project are accepted.'
                    : undefined
                }
              >
                <MemberSelect value={value} onChange={setValue} />
              </Field>
            ) : action === 'move_stage' ? (
              <Field
                label="Target stage"
                required
                helper="Review, approval and changes requested are reached only through reviews."
              >
                <Select
                  value={value}
                  onChange={setValue}
                  options={MOVABLE.map((s) => ({ value: s, label: label('contentStage', s) }))}
                />
              </Field>
            ) : (
              <Field label="Tag" required>
                <Input value={value ?? ''} onChange={(e) => setValue(e.target.value)} maxLength={40} />
              </Field>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
};
