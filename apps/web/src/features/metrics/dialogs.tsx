'use client';
import { useState } from 'react';
import { metricsEndpoints as M, type CheckpointRow } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Button, Dialog, Field, Textarea } from '@castlane/ui';
import { useWorkspace } from '@/lib/workspace-context';
import { errorMessage, useInsightsMutation } from './common';

/**
 * Mark Unavailable (S49): closes the checkpoint as Missing with a reason. No values are created —
 * a Missing checkpoint is expected but never usable in coverage (T114).
 */
export const MarkMissingDialog = ({ checkpoint, onClose }: { checkpoint: CheckpointRow; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useInsightsMutation(M.markMissing, { successMessage: 'Checkpoint marked as Missing' });
  const submit = async () => {
    setError(null);
    if (reason.trim().length < 3) return setError('Enter why the values are not available.');
    try {
      await m.run({ params: { workspaceId: workspace.id, checkpointId: checkpoint.id }, body: { reason: reason.trim() } }, { ifMatch: checkpoint.rowVersion });
      onClose();
    } catch (e) {
      setError(isApiError(e) && e.code === 'VERSION_CONFLICT' ? 'This checkpoint changed in the meantime. Close the dialog and try again.' : errorMessage(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      size="small"
      title="Mark Unavailable"
      description={`${checkpoint.entity.label} · ${checkpoint.label}. The request is closed as Missing; no values are recorded and coverage counts it as missing.`}
      dirty={reason.length > 0}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => void submit()}>
            Mark Unavailable
          </Button>
        </>
      }
    >
      <Field label="Reason" required error={error}>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} placeholder="For example: the post was removed by the platform." />
      </Field>
    </Dialog>
  );
};
