'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { campaignEndpoints as C, type CampaignDetail, type CampaignRow } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Banner, Button, Checkbox, DateInput, Dialog, Field, Input, Textarea } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { EntitySelect } from '@/components/common/entity-select';
import { useApiMutation } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { ARCHIVE_EXPLANATION } from '@/features/publications/labels';
import { CAMPAIGN_INVALIDATE, DUPLICATE_NOTE } from './labels';

type CampaignLike = Pick<CampaignRow, 'id' | 'name' | 'status' | 'startDate' | 'endDate' | 'rowVersion'>;

const TRANSITION_TITLE: Record<string, string> = { active: 'Start Campaign', closed: 'Close Campaign', archived: 'Archive Campaign' };

/** Start / Close (with a closing summary) / Reopen (with a reason). */
export const TransitionCampaignDialog = ({ campaign: c, target, onClose }: { campaign: CampaignDetail; target: CampaignDetail['status'] | null; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const m = useApiMutation(C.transition, { invalidate: CAMPAIGN_INVALIDATE, silentErrors: true, successMessage: (r) => `Campaign ${label('campaignStatus', r.status).toLowerCase()}` });
  if (!target) return null;
  const reopening = target === 'active' && c.status === 'closed';
  const closing = target === 'closed' && c.status !== 'archived';
  const title = reopening ? 'Reopen Campaign' : c.status === 'archived' && target === 'closed' ? 'Restore Campaign' : (TRANSITION_TITLE[target] ?? 'Change status');
  const needs = closing ? 'summary' : reopening ? 'reason' : null;
  const submit = async () => {
    setError(null);
    if (needs && text.trim().length < 3) {
      setError(needs === 'summary' ? 'Summarize the outcome (at least 3 characters).' : 'Give a reason (at least 3 characters).');
      return;
    }
    try {
      await m.run(
        {
          params: { workspaceId: workspace.id, campaignId: c.id },
          body: { targetStatus: target, ...(needs === 'summary' ? { closingSummary: text.trim() } : needs === 'reason' ? { reason: text.trim() } : {}) },
        },
        { ifMatch: c.rowVersion },
      );
      setText('');
      onClose();
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else setError(isApiError(e) ? e.message : 'The status could not be changed.');
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        size="small"
        title={title}
        description={c.name}
        dirty={!!text}
        footer={
          <>
            <Button onClick={onClose} disabled={m.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={m.isPending} onClick={() => void submit()}>
              {title}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          {target === 'active' && !reopening ? <p className="text-[14px] text-fg-2">The campaign becomes Active. Placements and tagged links keep working as before.</p> : null}
          {needs === 'summary' ? (
            <Field label="Closing summary" required helper="What happened and what was learned. Results stay as reported; closing does not calculate anything.">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} maxLength={5000} autoFocus />
            </Field>
          ) : null}
          {needs === 'reason' ? (
            <Field label="Reason" required helper="Recorded in the campaign history.">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} autoFocus />
            </Field>
          ) : null}
        </div>
      </Dialog>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </>
  );
};

/** Duplicate Structure: a new Planned campaign without costs, income, placements or results. */
export const DuplicateCampaignDialog = ({ campaign: c, open, onOpenChange }: { campaign: CampaignLike; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const router = useRouter();
  const wsPath = useWsPath();
  const [name, setName] = useState(`${c.name} (copy)`.slice(0, 120));
  const [startDate, setStart] = useState(c.startDate);
  const [endDate, setEnd] = useState(c.endDate);
  const [copyLinks, setCopyLinks] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const m = useApiMutation(C.duplicate, { invalidate: CAMPAIGN_INVALIDATE, silentErrors: true, successMessage: 'Campaign structure duplicated' });
  const submit = async () => {
    const next: Record<string, string> = {};
    if (name.trim().length < 2) next.name = 'Use 2–120 characters.';
    if (!startDate) next.startDate = 'Choose a start date.';
    if (!endDate) next.endDate = 'Choose an end date.';
    else if (startDate && endDate < startDate) next.endDate = 'The end date must be on or after the start date.';
    setErrors(next);
    setError(null);
    if (Object.keys(next).length) return;
    try {
      const r = await m.run({ params: { workspaceId: workspace.id, campaignId: c.id }, body: { name: name.trim(), startDate, endDate, copyTrackingLinks: copyLinks } });
      onOpenChange(false);
      router.push(wsPath(`/campaigns/${r.id}`));
    } catch (e) {
      if (isApiError(e) && e.fieldErrors.length) setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field.replace(/^body\./, ''), f.message])));
      else setError(isApiError(e) ? e.message : 'The campaign could not be duplicated.');
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Duplicate Structure"
      description={DUPLICATE_NOTE}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={m.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} onClick={() => void submit()}>
            Duplicate
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Name" required error={errors.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Start date" required error={errors.startDate}>
            <DateInput value={startDate} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="End date" required error={errors.endDate}>
            <DateInput value={endDate} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Checkbox label="Copy tagged links" description="Links are copied without any reported clicks; they are not tied to placements." checked={copyLinks} onCheckedChange={(v) => setCopyLinks(v === true)} />
      </div>
    </Dialog>
  );
};

/** Link Deal: an explicit relation between the campaign and a partnership deal (no amounts copied). */
export const LinkDealDialog = ({ campaign: c, open, onOpenChange }: { campaign: CampaignDetail; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [dealId, setDealId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const m = useApiMutation(C.linkDeal, { invalidate: CAMPAIGN_INVALIDATE, silentErrors: true, successMessage: 'Deal linked' });
  const submit = async () => {
    setError(null);
    if (!dealId) {
      setError('Choose a deal.');
      return;
    }
    try {
      await m.run({ params: { workspaceId: workspace.id, campaignId: c.id }, body: { dealId } });
      setDealId(null);
      onOpenChange(false);
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The deal could not be linked.');
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title="Link Deal"
      description="The deal points to this campaign. Deal amounts are not copied into campaign costs or results."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={m.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} onClick={() => void submit()}>
            Link Deal
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Deal" required helper={c.partner ? `Deals with ${c.partner.name} and other partners you can see.` : undefined}>
          <EntitySelect type="deal" value={dealId} onChange={setDealId} />
        </Field>
      </div>
    </Dialog>
  );
};

/** Archive a Planned or Closed campaign with an optional reason. */
export const ArchiveCampaignDialog = ({ campaign: c, open, onOpenChange }: { campaign: CampaignLike; open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const m = useApiMutation(C.archive, { invalidate: CAMPAIGN_INVALIDATE, silentErrors: true, successMessage: 'Campaign archived' });
  const submit = async () => {
    setError(null);
    if (reason.trim() && reason.trim().length < 3) {
      setError('Give a reason of at least 3 characters, or leave it empty.');
      return;
    }
    try {
      await m.run({ params: { workspaceId: workspace.id, campaignId: c.id }, body: reason.trim() ? { reason: reason.trim() } : {} }, { ifMatch: c.rowVersion });
      onOpenChange(false);
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
      else setError(isApiError(e) ? e.message : 'The campaign could not be archived.');
    }
  };
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        size="small"
        title="Archive campaign?"
        description={c.name}
        footer={
          <>
            <Button onClick={() => onOpenChange(false)} disabled={m.isPending}>
              Keep
            </Button>
            <Button variant="danger" loading={m.isPending} onClick={() => void submit()}>
              Archive
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <p className="text-[14px] text-fg-2">{ARCHIVE_EXPLANATION} Placements, tagged links and source reports stay linked; nothing is deleted.</p>
          <Field label="Reason" helper="Optional.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={2000} />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </>
  );
};
