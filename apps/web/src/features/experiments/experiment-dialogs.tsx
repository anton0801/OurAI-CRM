'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { experimentEndpoints as X, type ExperimentDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { METRIC_SEGMENTS } from '@castlane/domain';
import { Banner, Button, DateTimeInput, DescriptionList, Dialog, Field, Select, Textarea } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { useEditBase } from '@/lib/edit-base';
import { EntitySelect, MultiEntitySelect } from '@/components/common/entity-select';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { ARCHIVE_EXPLANATION } from '@/features/publications/labels';
import { fromLocalInput } from '@/features/tasks/format';
import { EXPERIMENT_INVALIDATE, ORGANIC_CAVEAT, windowText } from './labels';

type Errors = Record<string, string>;
const fieldErrors = (e: unknown): Errors | null => (isApiError(e) && e.fieldErrors.length ? Object.fromEntries(e.fieldErrors.map((f) => [f.field.replace(/^body\./, ''), f.message])) : null);

/** Each dialog acts on the experiment as it opened (T162): `version` is its If-Match, a 412 opens the Conflict dialog. */
const useConflict = (experiment: ExperimentDetail, onReload?: (latest: ExperimentDetail) => void) => {
  const edit = useEditBase(experiment, { onReload });
  const node = <ConflictDialog {...edit.conflictDialog} />;
  return { version: edit.version, node, onError: edit.catchConflict };
};

/** Start: the plan (hypothesis, variants, metric, window, sample, limitations) is frozen as version 1. */
export const StartExperimentDialog = ({ experiment: e, onClose }: { experiment: ExperimentDetail; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [startAt, setStartAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const conflict = useConflict(e);
  const m = useApiMutation(X.start, { invalidate: EXPERIMENT_INVALIDATE, silentErrors: true, successMessage: 'Experiment started; plan version 1 frozen' });
  const submit = async () => {
    setError(null);
    try {
      const at = startAt ? fromLocalInput(startAt, user.timezone) : null;
      await m.run({ params: { workspaceId: workspace.id, experimentId: e.id }, body: at ? { startAt: at } : {} }, { ifMatch: conflict.version });
      onClose();
    } catch (err) {
      if (!conflict.onError(err)) setError(fieldErrors(err)?.startAt ?? (isApiError(err) ? err.message : 'The experiment could not be started.'));
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title="Start experiment"
        description="Starting freezes the plan. Later changes need a reason and create a new plan version."
        footer={
          <>
            <Button onClick={onClose} disabled={m.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={m.isPending} onClick={() => void submit()}>
              Start
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <DescriptionList
            columns={2}
            items={[
              { label: 'Variants', value: e.variants.map((v) => v.name).join(' · ') },
              { label: 'Primary metric', value: e.primaryMetricLabel },
              { label: 'Window', value: windowText(e.observationWindowHours) },
              { label: 'Minimum sample', value: `${e.minimumSample} per variant` },
              { label: 'Limitations', value: e.limitations },
            ]}
          />
          <Field label="Start at" helper={e.startAt ? 'Leave empty to keep the planned start.' : 'Leave empty to start now.'}>
            <DateTimeInput value={startAt} onChange={(ev) => setStartAt(ev.target.value)} timezone={user.timezone} />
          </Field>
          <p className="text-[13px] text-fg-2">{ORGANIC_CAVEAT}</p>
        </div>
      </Dialog>
      {conflict.node}
    </>
  );
};

/** Conclude: findings and limitations; selecting a variant is the owner's judgement with a rationale. */
export const ConcludeExperimentDialog = ({ experiment: e, onClose }: { experiment: ExperimentDetail; onClose: () => void }) => {
  const { workspace, membershipId, isOwner } = useWorkspace();
  const results = useApiQuery(X.results, { params: { workspaceId: workspace.id, experimentId: e.id } });
  const [findings, setFindings] = useState(e.resultNote ?? '');
  const [limitations, setLimitations] = useState(e.limitations ?? '');
  const [variantId, setVariantId] = useState<string | null>(null);
  const [rationale, setRationale] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string | null>(null);
  const conflict = useConflict(e, (x) => {
    setFindings(x.resultNote ?? '');
    setLimitations(x.limitations ?? '');
  });
  const m = useApiMutation(X.conclude, { invalidate: EXPERIMENT_INVALIDATE, silentErrors: true, successMessage: 'Experiment concluded' });
  const mayChoose = e.owner.membershipId === membershipId || isOwner;
  const submit = async () => {
    const next: Errors = {};
    if (findings.trim().length < 10) next.findings = 'Describe what you observed (at least 10 characters).';
    if (limitations.trim().length < 3) next.limitations = 'Name the limitations (at least 3 characters).';
    if (variantId && rationale.trim().length < 10) next.selectionRationale = 'Explain why this variant is selected (at least 10 characters).';
    setErrors(next);
    setError(null);
    if (Object.keys(next).length) return;
    try {
      await m.run(
        {
          params: { workspaceId: workspace.id, experimentId: e.id },
          body: { findings: findings.trim(), limitations: limitations.trim(), selectedVariantId: variantId, ...(variantId ? { selectionRationale: rationale.trim() } : {}) },
        },
        { ifMatch: conflict.version },
      );
      onClose();
    } catch (err) {
      if (conflict.onError(err)) return;
      const f = fieldErrors(err);
      if (f) setErrors(f);
      else setError(isApiError(err) ? err.message : 'The experiment could not be concluded.');
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        size="wide"
        title="Conclude experiment"
        description="The current comparable results are saved as evidence. No winner is chosen automatically."
        dirty={!!findings && findings !== (e.resultNote ?? '')}
        footer={
          <>
            <Button onClick={onClose} disabled={m.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={m.isPending} onClick={() => void submit()}>
              Conclude
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Banner tone="info">{ORGANIC_CAVEAT}</Banner>
          {results.data ? (
            <p className="text-[13px] text-fg-2">
              Current results: {RESULT_STATUS[results.data.status]}
              {results.data.reasons.length ? ` — ${results.data.reasons.join(' ')}` : ''}
            </p>
          ) : null}
          <Field label="Findings" required error={errors.findings}>
            <Textarea value={findings} onChange={(ev) => setFindings(ev.target.value)} rows={4} maxLength={5000} autoFocus />
          </Field>
          <Field label="Limitations" required error={errors.limitations}>
            <Textarea value={limitations} onChange={(ev) => setLimitations(ev.target.value)} rows={3} maxLength={5000} />
          </Field>
          <Field label="Selected variant" error={errors.selectedVariantId} helper={mayChoose ? 'Optional. A judgement, not proof of causality.' : 'Only the experiment owner selects a variant.'}>
            <Select value={variantId} onChange={setVariantId} clearable disabled={!mayChoose} placeholder="No variant selected" options={e.variants.map((v) => ({ value: v.id, label: v.name }))} />
          </Field>
          {variantId ? (
            <Field label="Rationale" required error={errors.selectionRationale}>
              <Textarea value={rationale} onChange={(ev) => setRationale(ev.target.value)} rows={3} maxLength={2000} />
            </Field>
          ) : null}
        </div>
      </Dialog>
      {conflict.node}
    </>
  );
};

export const RESULT_STATUS: Record<string, string> = {
  comparable: 'Comparable',
  not_comparable: 'Not Comparable',
  insufficient_sample: 'Insufficient sample',
  no_data: 'No data recorded',
};

/** Link Publications: placements of the experiment's project, to one variant, in one segment. */
export const LinkPublicationsDialog = ({ experiment: e, onClose, initialVariantId }: { experiment: ExperimentDetail; onClose: () => void; initialVariantId?: string }) => {
  const { workspace } = useWorkspace();
  const [variantId, setVariantId] = useState<string | null>(initialVariantId ?? e.variants[0]?.id ?? null);
  const [ids, setIds] = useState<string[]>([]);
  const [segment, setSegment] = useState<(typeof METRIC_SEGMENTS)[number]>('organic');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<string | null>(null);
  const conflict = useConflict(e);
  const running = e.status === 'running';
  const m = useApiMutation(X.linkPublications, { invalidate: EXPERIMENT_INVALIDATE, silentErrors: true, successMessage: 'Publications linked' });
  const submit = async () => {
    const next: Errors = {};
    if (!variantId) next.variantId = 'Choose a variant.';
    if (!ids.length) next.publicationIds = 'Choose at least one publication.';
    if (running && reason.trim().length < 3) next.reason = 'The experiment is running: give a reason for this plan revision.';
    setErrors(next);
    setError(null);
    if (Object.keys(next).length) return;
    try {
      await m.run({ params: { workspaceId: workspace.id, experimentId: e.id }, body: { variantId: variantId!, publicationIds: ids, segment, ...(running ? { reason: reason.trim() } : {}) } }, { ifMatch: conflict.version });
      onClose();
    } catch (err) {
      if (conflict.onError(err)) return;
      const f = fieldErrors(err);
      if (f) setErrors(f);
      else setError(isApiError(err) ? err.message : 'The publications could not be linked.');
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title="Link Publications"
        description={`Placements of ${e.project.name}. Paid and organic results are kept apart.`}
        dirty={ids.length > 0}
        footer={
          <>
            <Button onClick={onClose} disabled={m.isPending}>
              Cancel
            </Button>
            <Button variant="primary" loading={m.isPending} onClick={() => void submit()}>
              Link
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Variant" required error={errors.variantId}>
              <Select value={variantId} onChange={setVariantId} options={e.variants.map((v) => ({ value: v.id, label: v.name }))} />
            </Field>
            <Field label="Segment" required error={errors.segment} helper="Paid boosts are compared separately from organic reach.">
              <Select value={segment} onChange={(v) => v && setSegment(v)} options={METRIC_SEGMENTS.map((s) => ({ value: s, label: label('segment', s) }))} />
            </Field>
          </div>
          <Field label="Publications" required error={errors.publicationIds} helper="Cancelled placements cannot be compared.">
            <MultiEntitySelect type="publication" value={ids} onChange={setIds} filters={{ projectId: e.project.id }} max={100} />
          </Field>
          {running ? (
            <Field label="Reason" required error={errors.reason} helper="Linking after the start creates a new plan version.">
              <Textarea value={reason} onChange={(ev) => setReason(ev.target.value)} rows={2} maxLength={2000} />
            </Field>
          ) : null}
        </div>
      </Dialog>
      {conflict.node}
    </>
  );
};

/** Remove one linked placement (running: with a reason). */
export const UnlinkPublicationDialog = ({ experiment: e, link, onClose }: { experiment: ExperimentDetail; link: ExperimentDetail['publications'][number]; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const conflict = useConflict(e);
  const running = e.status === 'running';
  const m = useApiMutation(X.unlinkPublication, { invalidate: EXPERIMENT_INVALIDATE, silentErrors: true, successMessage: 'Publication removed from the experiment' });
  const submit = async () => {
    setError(null);
    if (running && reason.trim().length < 3) {
      setError('The experiment is running: give a reason for this plan revision.');
      return;
    }
    try {
      await m.run({ params: { workspaceId: workspace.id, experimentId: e.id, linkId: link.linkId }, body: running ? { reason: reason.trim() } : {} }, { ifMatch: conflict.version });
      onClose();
    } catch (err) {
      if (!conflict.onError(err)) setError(isApiError(err) ? err.message : 'The publication could not be removed.');
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        size="small"
        title="Remove from experiment?"
        description={link.publication.title}
        footer={
          <>
            <Button onClick={onClose} disabled={m.isPending}>
              Keep
            </Button>
            <Button variant="danger" loading={m.isPending} onClick={() => void submit()}>
              Remove
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <p className="text-[14px] text-fg-2">The placement itself is not changed; it only stops counting for this experiment.</p>
          {running ? (
            <Field label="Reason" required>
              <Textarea value={reason} onChange={(ev) => setReason(ev.target.value)} rows={2} maxLength={2000} />
            </Field>
          ) : null}
        </div>
      </Dialog>
      {conflict.node}
    </>
  );
};

/** Duplicate Hypothesis: a new Draft with the same plan, without linked publications or results. */
export const DuplicateExperimentDialog = ({ experiment: e, onClose }: { experiment: ExperimentDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const router = useRouter();
  const wsPath = useWsPath();
  const [projectId, setProjectId] = useState<string | null>(e.project.id);
  const [error, setError] = useState<string | null>(null);
  const m = useApiMutation(X.duplicate, { invalidate: EXPERIMENT_INVALIDATE, silentErrors: true, successMessage: 'Hypothesis duplicated as a Draft' });
  const submit = async () => {
    setError(null);
    try {
      const r = await m.run({ params: { workspaceId: workspace.id, experimentId: e.id }, body: projectId && projectId !== e.project.id ? { projectId } : {} });
      onClose();
      router.push(wsPath(`/experiments/${r.id}`));
    } catch (err) {
      setError(fieldErrors(err)?.projectId ?? (isApiError(err) ? err.message : 'The hypothesis could not be duplicated.'));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title="Duplicate Hypothesis"
      description="Copies the hypothesis, variants, metric, window, sample and limitations into a new Draft. Linked publications and results are not copied."
      footer={
        <>
          <Button onClick={onClose} disabled={m.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.isPending} onClick={() => void submit()}>
            Duplicate
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Project">
          <EntitySelect type="project" value={projectId} onChange={setProjectId} />
        </Field>
      </div>
    </Dialog>
  );
};

/** Archive a draft or concluded experiment (restored from the Archive screen). */
export const ArchiveExperimentDialog = ({ experiment: e, onClose }: { experiment: ExperimentDetail; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const conflict = useConflict(e);
  const m = useApiMutation(X.archive, { invalidate: EXPERIMENT_INVALIDATE, silentErrors: true, successMessage: 'Experiment archived' });
  const submit = async () => {
    setError(null);
    try {
      await m.run({ params: { workspaceId: workspace.id, experimentId: e.id }, body: reason.trim().length >= 3 ? { reason: reason.trim() } : {} }, { ifMatch: conflict.version });
      onClose();
    } catch (err) {
      if (!conflict.onError(err)) setError(isApiError(err) ? err.message : 'The experiment could not be archived.');
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        size="small"
        title="Archive experiment?"
        description={e.hypothesis}
        footer={
          <>
            <Button onClick={onClose} disabled={m.isPending}>
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
          <p className="text-[14px] text-fg-2">{ARCHIVE_EXPLANATION}</p>
          <Field label="Reason" helper="Optional.">
            <Textarea value={reason} onChange={(ev) => setReason(ev.target.value)} rows={2} maxLength={2000} />
          </Field>
        </div>
      </Dialog>
      {conflict.node}
    </>
  );
};
