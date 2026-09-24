'use client';
import { ClipboardText, Plus, Trash } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { ofmEndpoints as E, type OfmQualityReview, type OfmRubricVersion } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { QUALITY_REVIEW_STATES } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  DateTimeInput,
  DescriptionList,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  MultiSelect,
  NoResults,
  PageHeader,
  Panel,
  RadioGroup,
  Select,
  StatusBadge,
  Tabs,
  Textarea,
  Toolbar,
  formatDateTime,
  formatPercent,
  toast,
  type Column,
} from '@castlane/ui';
import { MultiEntitySelect, EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiInfinite, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { MemberChip, OfmNav, ReasonDialog, errorMessage, fromLocalInput, runAction, useOfmMutation } from './common';
import { OfmModelSelect } from './pickers';

type Keys = 'view' | 'state' | 'member' | 'projectId' | 'open' | 'draft';
type Score = { score: number | null | undefined; note: string; evidence: string[] };
type Scores = Record<string, Score>;

const scoreText = (r: Pick<OfmQualityReview, 'totalScore' | 'applicableCriteria'>) => (r.totalScore === null ? 'No Score' : formatPercent(r.totalScore, 1));

const reviewStatus = (s: OfmQualityReview['state']) => (s === 'published' ? 'approved' : s === 'disputed' ? 'pending' : s === 'resolved' ? 'completed' : 'draft');

/** S48 Quality Reviews: verifiable feedback scored against a versioned rubric; disputes keep the original score. */
export const QualityScreen = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const reviewer = can('quality.write');
  const scope = can(['quality.read.scope', 'quality.write', 'quality.publish']);
  const { state, set, list } = useUrlState<Keys>({ view: scope ? 'all' : 'mine' });
  const view = (['mine', 'reviewing', 'all', 'rubrics'].includes(state.view ?? '') ? state.view : 'mine') as 'mine' | 'reviewing' | 'all' | 'rubrics';
  const states = list('state') as OfmQualityReview['state'][];
  const data = useApiInfinite(
    E.listQuality,
    {
      params: { workspaceId: workspace.id },
      query: { view: view === 'rubrics' ? 'all' : view, state: states.length ? states : undefined, subjectMembershipId: state.member, projectId: state.projectId },
    },
    { enabled: view !== 'rubrics' },
  );
  const filtered = !!(states.length || state.member || state.projectId);
  const columns: Column<OfmQualityReview>[] = [
    {
      key: 'subject',
      header: 'Subject',
      sticky: true,
      minWidth: 220,
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-medium">{r.subject.label}</span>
          <span className="text-[12px] text-fg-2">
            {r.subjectType === 'shift' ? 'Shift' : 'Operation'}
            {r.subject.at ? ` · ${formatDateTime(r.subject.at, user.timezone)}` : ''}
          </span>
        </span>
      ),
    },
    { key: 'member', header: 'Member', minWidth: 180, cell: (r) => <MemberChip member={r.subjectMember} size={28} /> },
    { key: 'reviewer', header: 'Reviewer', minWidth: 180, cell: (r) => <MemberChip member={r.reviewer} size={28} /> },
    { key: 'rubric', header: 'Rubric Version', minWidth: 170, cell: (r) => `${r.rubric.name} v${r.rubric.versionNo}` },
    { key: 'score', header: 'Rubric Score', align: 'right', minWidth: 120, cell: (r) => <span className="font-mono tabular-nums">{scoreText(r)}</span> },
    { key: 'state', header: 'Status', minWidth: 120, cell: (r) => <StatusBadge status={reviewStatus(r.state)} label={label('qualityState', r.state)} /> },
    { key: 'published', header: 'Published', minWidth: 150, cell: (r) => (r.publishedAt ? formatDateTime(r.publishedAt, user.timezone) : '—') },
    { key: 'ack', header: 'Acknowledged', minWidth: 150, cell: (r) => (r.acknowledgedAt ? formatDateTime(r.acknowledgedAt, user.timezone) : '—') },
  ];
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Quality Reviews"
        crumbs={[{ label: 'OFM', href: wsPath('/ofm') }, { label: 'Quality' }]}
        description="A score is the result of a rubric version for one shift or operation — not an absolute rating of a person. External conversations are only judged from evidence provided."
        actions={
          reviewer ? (
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => set({ draft: '1' })}>
              Draft Review
            </Button>
          ) : undefined
        }
      />
      <OfmNav />
      <Tabs
        label="Review lists"
        value={view}
        onValueChange={(v) => set({ view: v, open: null })}
        items={[
          { value: 'mine', label: 'About Me' },
          { value: 'reviewing', label: 'Written by Me', hidden: !reviewer },
          { value: 'all', label: 'All in Scope', hidden: !scope },
          { value: 'rubrics', label: 'Rubrics' },
        ]}
      />
      {view === 'rubrics' ? (
        <RubricsPanel />
      ) : (
        <>
          <Toolbar>
            <div className="w-full sm:w-[220px]">
              <MultiSelect aria-label="Status" placeholder="Any status" value={states} onChange={(v) => set({ state: v.join(',') || null })} options={QUALITY_REVIEW_STATES.map((s) => ({ value: s, label: label('qualityState', s) }))} />
            </div>
            {view !== 'mine' ? (
              <div className="w-full sm:w-[190px]">
                <MemberSelect aria-label="Member" placeholder="Any member" value={state.member} onChange={(v) => set({ member: v })} clearable />
              </div>
            ) : null}
            <div className="w-full sm:w-[190px]">
              <OfmModelSelect aria-label="Model" placeholder="All models" value={state.projectId} onChange={(v) => set({ projectId: v })} clearable />
            </div>
          </Toolbar>
          <QueryState query={data}>
            {data.items.length === 0 && !data.isFetching ? (
              filtered ? (
                <NoResults onClear={() => set({ state: null, member: null, projectId: null })} />
              ) : (
                <EmptyState
                  icon={<ClipboardText size={28} />}
                  title="No quality reviews"
                  description={view === 'mine' ? 'Published reviews of your shifts and operations appear here.' : 'Draft a review of a shift or operation using a published rubric.'}
                  action={reviewer && view !== 'mine' ? <Button variant="primary" onClick={() => set({ draft: '1' })}>Draft Review</Button> : undefined}
                />
              )
            ) : (
              <DataTable
                caption="Quality reviews"
                rows={data.items}
                columns={columns}
                getRowId={(r) => r.id}
                density={user.density}
                onRowClick={(r) => set({ open: r.id })}
                selectedRowId={state.open ?? null}
                hasMore={data.hasNextPage}
                loadingMore={data.isFetchingNextPage}
                onLoadMore={() => void data.fetchNextPage()}
              />
            )}
          </QueryState>
        </>
      )}
      {state.draft === '1' ? <ReviewEditor onClose={(id) => set({ draft: null, open: id ?? null })} /> : null}
      {state.open ? <ReviewDrawer id={state.open} onClose={() => set({ open: null })} /> : null}
    </div>
  );
};

// ——— Score editor ———

const ScoreEditor = ({ rubric, scores, onChange, projectId }: { rubric: OfmRubricVersion; scores: Scores; onChange: (s: Scores) => void; projectId?: string }) => (
  <div className="flex flex-col gap-4">
    {rubric.criteria.map((c) => {
      const s = scores[c.key] ?? { score: undefined, note: '', evidence: [] };
      const value = s.score === undefined ? '' : s.score === null ? 'na' : String(s.score);
      const negative = s.score !== undefined && s.score !== null && s.score <= 1;
      return (
        <fieldset key={c.key} className="flex flex-col gap-2 rounded-[12px] border border-line p-3">
          <legend className="px-1 text-[13px] font-semibold text-fg">
            {c.label} <span className="font-normal text-fg-2">· weight {formatPercent(c.weight, 0)}</span>
          </legend>
          {c.description ? <p className="text-[12px] text-fg-2">{c.description}</p> : null}
          <RadioGroup
            label={`${c.label} score`}
            orientation="horizontal"
            value={value}
            onValueChange={(v) => onChange({ ...scores, [c.key]: { ...s, score: v === 'na' ? null : Number(v) } })}
            options={[...['0', '1', '2', '3', '4'].map((n) => ({ value: n, label: n })), { value: 'na', label: 'Not Applicable' }]}
          />
          <Field label="Factual note" helper={negative ? 'Scores 0–1 need evidence before publishing.' : undefined}>
            <Textarea value={s.note} onChange={(e) => onChange({ ...scores, [c.key]: { ...s, note: e.target.value } })} rows={2} maxLength={2000} />
          </Field>
          <Field label="Evidence" error={negative && !s.evidence.length ? 'Add evidence for a score of 0 or 1.' : undefined}>
            <MultiEntitySelect type="asset" filters={{ projectId }} disabled={!projectId} value={s.evidence} onChange={(ids) => onChange({ ...scores, [c.key]: { ...s, evidence: ids } })} max={20} />
          </Field>
        </fieldset>
      );
    })}
  </div>
);

const toScoreBody = (scores: Scores) =>
  Object.entries(scores)
    .filter(([, s]) => s.score !== undefined)
    .map(([key, s]) => ({ key, score: s.score as number | null, note: s.note.trim() || undefined, evidenceAssetIds: s.evidence.length ? s.evidence : undefined }));

const fromReview = (r: OfmQualityReview): Scores => Object.fromEntries(r.scores.map((s) => [s.key, { score: s.score, note: s.note ?? '', evidence: s.evidenceAssetIds ?? [] }]));

const previewScore = (rubric: OfmRubricVersion | undefined, scores: Scores) => {
  if (!rubric) return null;
  let weight = 0;
  let sum = 0;
  let all = true;
  for (const c of rubric.criteria) {
    const s = scores[c.key];
    if (!s || s.score === undefined) {
      all = false;
      continue;
    }
    if (s.score === null) continue;
    weight += Number(c.weight);
    sum += (s.score / 4) * Number(c.weight);
  }
  return { complete: all, value: weight > 0 ? (sum / weight) * 100 : null };
};

/** Draft (or edit a draft) review; Publish freezes it after server checks (all criteria, evidence for 0–1). */
const ReviewEditor = ({ review, onClose }: { review?: OfmQualityReview; onClose: (id?: string) => void }) => {
  const { workspace, membershipId } = useWorkspace();
  const rubrics = useApiQuery(E.listRubrics, { params: { workspaceId: workspace.id } });
  const [subjectType, setSubjectType] = useState<'shift' | 'operation'>(review?.subjectType ?? 'shift');
  const [subjectId, setSubjectId] = useState<string | null>(review?.subject.id ?? null);
  const [rubricId, setRubricId] = useState<string | null>(review?.rubric.id ?? null);
  const [scores, setScores] = useState<Scores>(review ? fromReview(review) : {});
  const [facts, setFacts] = useState(review?.factualNotes ?? '');
  const [improvements, setImprovements] = useState(review?.improvements ?? '');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const create = useOfmMutation(E.createQuality, { successMessage: 'Draft saved' });
  const update = useOfmMutation(E.updateQuality, { successMessage: 'Draft saved' });
  const publish = useOfmMutation(E.publishQuality, { successMessage: 'Review published', also: ['myWork.'] });
  const ops = useApiQuery(E.listOperations, { params: { workspaceId: workspace.id }, query: { sort: 'updatedAt', direction: 'desc', pageSize: 100 } }, { enabled: subjectType === 'operation' && !review });
  const shiftQ = useApiQuery(E.getShift, { params: { workspaceId: workspace.id, shiftId: subjectId ?? '' } }, { enabled: !review && subjectType === 'shift' && !!subjectId });
  const projectId = review?.project.id ?? (subjectType === 'shift' ? shiftQ.data?.project.id : ops.data?.items.find((o) => o.id === subjectId)?.project.id);
  const published = (rubrics.data ?? []).filter((r) => r.state === 'published' || r.id === rubricId);
  const rubric = published.find((r) => r.id === rubricId);
  const preview = previewScore(rubric, scores);
  const pending = create.isPending || update.isPending || publish.isPending;

  const save = async () => {
    setError(null);
    setFieldErrors([]);
    try {
      if (review) {
        return await update.run(
          { params: { workspaceId: workspace.id, reviewId: review.id }, body: { rubricVersionId: rubricId ?? undefined, scores: toScoreBody(scores), factualNotes: facts.trim() || null, improvements: improvements.trim() || null } },
          { ifMatch: review.rowVersion },
        );
      }
      return await create.run({
        params: { workspaceId: workspace.id },
        body: { subjectType, subjectId: subjectId!, rubricVersionId: rubricId!, scores: toScoreBody(scores), factualNotes: facts.trim() || null, improvements: improvements.trim() || null },
      });
    } catch (e) {
      if (isApiError(e) && e.fieldErrors.length) setFieldErrors(e.fieldErrors.map((f) => f.message));
      setError(errorMessage(e, 'The review could not be saved.'));
      return null;
    }
  };
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title={review ? 'Edit Draft Review' : 'Draft Review'}
      description="You cannot review your own work. Score what the evidence shows."
      width={760}
      dirty={!pending}
      footer={
        <>
          <Button onClick={() => onClose()} disabled={pending}>
            Cancel
          </Button>
          <Button
            loading={create.isPending || update.isPending}
            disabled={!subjectId || !rubricId}
            onClick={async () => {
              const r = await save();
              if (r) onClose(r.id);
            }}
          >
            Save Draft
          </Button>
          <Button
            variant="primary"
            loading={publish.isPending}
            disabled={!subjectId || !rubricId || !preview?.complete}
            onClick={async () => {
              const r = await save();
              if (!r) return;
              try {
                await publish.run({ params: { workspaceId: workspace.id, reviewId: r.id } }, { ifMatch: r.rowVersion });
                onClose(r.id);
              } catch (e) {
                if (isApiError(e) && e.fieldErrors.length) setFieldErrors(e.fieldErrors.map((f) => f.message));
                setError(errorMessage(e, 'The review was saved as a draft but could not be published.'));
              }
            }}
          >
            Publish Review
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <Banner tone="danger">
            {error}
            {fieldErrors.length ? (
              <ul className="mt-1 list-disc pl-5">
                {fieldErrors.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            ) : null}
          </Banner>
        ) : null}
        {!review ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Subject Type" required>
              <Select
                value={subjectType}
                onChange={(v) => {
                  if (v) setSubjectType(v);
                  setSubjectId(null);
                }}
                options={[
                  { value: 'shift', label: 'Shift' },
                  { value: 'operation', label: 'Operation' },
                ]}
              />
            </Field>
            <Field label={subjectType === 'shift' ? 'Shift' : 'Operation'} required>
              {subjectType === 'shift' ? (
                <EntitySelect type="shift" value={subjectId} onChange={setSubjectId} />
              ) : (
                <Select
                  value={subjectId}
                  onChange={setSubjectId}
                  placeholder={ops.isLoading ? 'Loading…' : 'Choose an operation'}
                  options={(ops.data?.items ?? []).filter((o) => o.owner.membershipId !== membershipId).map((o) => ({ value: o.id, label: o.title, description: `${o.owner.displayName} · ${label('operationStatus', o.status)}` }))}
                  emptyText="No operations in scope"
                />
              )}
            </Field>
          </div>
        ) : (
          <p className="text-[13px] text-fg-2">
            {review.subjectType === 'shift' ? 'Shift' : 'Operation'}: {review.subject.label} · {review.subjectMember.displayName}
          </p>
        )}
        <Field label="Rubric Version" required>
          <Select
            value={rubricId}
            onChange={(v) => {
              setRubricId(v);
              setScores({});
            }}
            placeholder={rubrics.isLoading ? 'Loading…' : 'Choose a published rubric'}
            options={published.map((r) => ({ value: r.id, label: `${r.name} v${r.versionNo}`, description: `${r.criteria.length} criteria` }))}
            emptyText="No published rubric yet"
          />
        </Field>
        {rubric ? (
          <>
            <ScoreEditor rubric={rubric} scores={scores} onChange={setScores} projectId={projectId} />
            <p className="text-[13px] text-fg-2">
              Preview: {preview?.value === null || preview === null ? 'No Score (every criterion Not Applicable)' : `${preview.value.toFixed(1)} %`}
              {preview && !preview.complete ? ' · score every criterion or mark it Not Applicable to publish' : ''}
            </p>
          </>
        ) : null}
        <Field label="Factual Notes">
          <Textarea value={facts} onChange={(e) => setFacts(e.target.value)} rows={4} maxLength={20000} />
        </Field>
        <Field label="Improvements">
          <Textarea value={improvements} onChange={(e) => setImprovements(e.target.value)} rows={3} maxLength={20000} />
        </Field>
      </div>
    </Drawer>
  );
};

// ——— Review detail ———

const ReviewDrawer = ({ id, onClose }: { id: string; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const q = useApiQuery(E.getQuality, { params: { workspaceId: workspace.id, reviewId: id } });
  const [dlg, setDlg] = useState<'edit' | 'publish' | 'ack' | 'dispute' | 'resolve' | 'task' | null>(null);
  const publish = useOfmMutation(E.publishQuality, { successMessage: 'Review published', also: ['myWork.'] });
  const dispute = useOfmMutation(E.disputeQuality, { successMessage: 'Dispute submitted' });
  const r = q.data;
  const openDispute = r?.disputes.find((d) => d.state === 'open');
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="Quality Review"
      width={760}
      footer={
        r ? (
          <div className="flex flex-wrap justify-end gap-2">
            {r.permissions.edit ? <Button onClick={() => setDlg('edit')}>Edit Draft</Button> : null}
            {r.permissions.publish ? (
              <Button variant="primary" onClick={() => setDlg('publish')}>
                Publish Review
              </Button>
            ) : null}
            {r.permissions.createImprovementTask ? <Button onClick={() => setDlg('task')}>Create Improvement Task</Button> : null}
            {r.permissions.dispute ? <Button onClick={() => setDlg('dispute')}>Dispute</Button> : null}
            {r.permissions.acknowledge ? (
              <Button variant="primary" onClick={() => setDlg('ack')}>
                Acknowledge
              </Button>
            ) : null}
            {r.permissions.resolveDispute && openDispute ? (
              <Button variant="primary" onClick={() => setDlg('resolve')}>
                Resolve Dispute
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <QueryState query={q}>
        {r ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={reviewStatus(r.state)} label={label('qualityState', r.state)} />
              <Badge tone="info">
                Rubric Score: {scoreText(r)}
                {r.totalScore !== null ? ` (${r.applicableCriteria} criteria applicable)` : ''}
              </Badge>
              {r.supersededAt ? <Badge tone="warning">Superseded</Badge> : null}
            </div>
            {r.replacedById ? (
              <Banner tone="info">
                A revised review replaced this one.{' '}
                <a className="underline" href={wsPath(`/ofm/quality?open=${r.replacedById}`)}>
                  Open the revision
                </a>
              </Banner>
            ) : null}
            {r.revisionOfId ? (
              <Banner tone="info">
                This is a revision after a dispute.{' '}
                <a className="underline" href={wsPath(`/ofm/quality?open=${r.revisionOfId}`)}>
                  Open the original
                </a>
              </Banner>
            ) : null}
            <DescriptionList
              items={[
                { label: r.subjectType === 'shift' ? 'Shift' : 'Operation', value: <a className="hover:underline" href={wsPath(r.subjectType === 'shift' ? `/ofm/shifts/${r.subject.id}` : `/ofm/operations?open=${r.subject.id}`)}>{r.subject.label}</a> },
                { label: 'Member', value: <MemberChip member={r.subjectMember} size={28} /> },
                { label: 'Reviewer', value: <MemberChip member={r.reviewer} size={28} /> },
                { label: 'Rubric Version', value: `${r.rubric.name} v${r.rubric.versionNo}` },
                { label: 'Published', value: r.publishedAt ? formatDateTime(r.publishedAt, user.timezone) : null },
                { label: 'Acknowledged', value: r.acknowledgedAt ? formatDateTime(r.acknowledgedAt, user.timezone) : null },
              ]}
            />
            <section>
              <h3 className="mb-2 text-[14px] font-semibold text-fg">Criteria</h3>
              <ul className="flex flex-col divide-y divide-line rounded-[12px] border border-line">
                {r.rubric.criteria.map((c) => {
                  const s = r.scores.find((x) => x.key === c.key);
                  return (
                    <li key={c.key} className="flex flex-col gap-1 px-3 py-2 text-[13px]">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-fg">
                          {c.label} <span className="font-normal text-fg-2">· {formatPercent(c.weight, 0)}</span>
                        </span>
                        <span className="font-mono tabular-nums">{!s ? 'Not scored' : s.score === null ? 'Not Applicable' : `${s.score} / 4`}</span>
                      </div>
                      {s?.note ? <p className="whitespace-pre-wrap text-fg-2">{s.note}</p> : null}
                      {s?.evidenceAssetIds?.length ? <p className="text-[12px] text-fg-2">Evidence: {s.evidenceAssetIds.length} asset(s), shown on request</p> : null}
                    </li>
                  );
                })}
              </ul>
            </section>
            {r.factualNotes ? (
              <section>
                <h3 className="mb-1 text-[14px] font-semibold text-fg">Factual Notes</h3>
                <p className="whitespace-pre-wrap text-[14px] leading-[22px]">{r.factualNotes}</p>
              </section>
            ) : null}
            {r.improvements ? (
              <section>
                <h3 className="mb-1 text-[14px] font-semibold text-fg">Improvements</h3>
                <p className="whitespace-pre-wrap text-[14px] leading-[22px]">{r.improvements}</p>
              </section>
            ) : null}
            {r.employeeResponse ? (
              <section>
                <h3 className="mb-1 text-[14px] font-semibold text-fg">Employee Response</h3>
                <p className="whitespace-pre-wrap text-[14px] leading-[22px]">{r.employeeResponse}</p>
              </section>
            ) : null}
            {r.disputes.length ? (
              <Panel title="Disputes">
                <ul className="flex flex-col gap-3 text-[13px]">
                  {r.disputes.map((d) => (
                    <li key={d.id} className="flex flex-col gap-1">
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <MemberChip member={d.raisedBy} /> · {formatDateTime(d.createdAt, user.timezone)}
                        <Badge tone={d.state === 'open' ? 'warning' : 'neutral'}>{d.state === 'open' ? 'Open' : `Resolved: ${label('disputeDecision', d.decision)}`}</Badge>
                      </span>
                      <p className="whitespace-pre-wrap text-fg">{d.reason}</p>
                      {d.resolution ? (
                        <p className="text-fg-2">
                          Resolution{d.resolvedBy ? ` by ${d.resolvedBy.displayName}` : ''}: {d.resolution}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
          </div>
        ) : null}
      </QueryState>
      {r && dlg === 'edit' ? <ReviewEditor review={r} onClose={() => setDlg(null)} /> : null}
      {r ? (
        <ConfirmDialog
          open={dlg === 'publish'}
          onOpenChange={(o) => !o && setDlg(null)}
          title="Publish review?"
          body="The member is notified and the review is frozen. Corrections later happen through a revision that keeps this one in history."
          confirmLabel="Publish Review"
          loading={publish.isPending}
          onConfirm={() => void runAction(() => publish.run({ params: { workspaceId: workspace.id, reviewId: r.id } }, { ifMatch: r.rowVersion })).then((ok) => ok && setDlg(null))}
        />
      ) : null}
      {r && dlg === 'ack' ? <AcknowledgeDialog r={r} onClose={() => setDlg(null)} /> : null}
      {r ? (
        <ReasonDialog
          open={dlg === 'dispute'}
          onOpenChange={(o) => !o && setDlg(null)}
          title="Dispute review"
          body="Explain what the review got wrong. The original score stays in history while the dispute is resolved."
          confirmLabel="Submit Dispute"
          reasonLabel="Dispute"
          onConfirm={(reason) => dispute.run({ params: { workspaceId: workspace.id, reviewId: r.id }, body: { reason } }, { ifMatch: r.rowVersion })}
        />
      ) : null}
      {r && dlg === 'resolve' && openDispute ? <ResolveDisputeDialog r={r} disputeId={openDispute.id} onClose={() => setDlg(null)} /> : null}
      {r && dlg === 'task' ? <ImprovementTaskDialog r={r} onClose={() => setDlg(null)} /> : null}
    </Drawer>
  );
};

const AcknowledgeDialog = ({ r, onClose }: { r: OfmQualityReview; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [response, setResponse] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useOfmMutation(E.acknowledgeQuality, { successMessage: 'Review acknowledged' });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title="Acknowledge review"
      description="Confirms you read the review. You can add a response."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={m.isPending}
            onClick={async () => {
              setError(null);
              try {
                await m.run({ params: { workspaceId: workspace.id, reviewId: r.id }, body: { response: response.trim() || undefined } }, { ifMatch: r.rowVersion });
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Acknowledge
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Response">
          <Textarea value={response} onChange={(e) => setResponse(e.target.value)} rows={4} maxLength={4000} />
        </Field>
      </div>
    </Dialog>
  );
};

const ResolveDisputeDialog = ({ r, disputeId, onClose }: { r: OfmQualityReview; disputeId: string; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [decision, setDecision] = useState<'upheld' | 'revised' | 'withdrawn'>('upheld');
  const [reason, setReason] = useState('');
  const [scores, setScores] = useState<Scores>(fromReview(r));
  const [facts, setFacts] = useState(r.factualNotes ?? '');
  const [error, setError] = useState<string | null>(null);
  const m = useOfmMutation(E.resolveDispute, { successMessage: 'Dispute resolved', also: ['myWork.'] });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="wide"
      title="Resolve dispute"
      description="Uphold keeps the review. Withdraw retracts it. Revise publishes a replacement revision; the original stays in history."
      dirty
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={reason.trim().length < 3}
            loading={m.isPending}
            onClick={async () => {
              setError(null);
              try {
                await m.run({
                  params: { workspaceId: workspace.id, disputeId },
                  body: { decision, reason: reason.trim(), replacementScores: decision === 'revised' ? toScoreBody(scores) : undefined, replacementFactualNotes: decision === 'revised' ? facts.trim() || null : undefined },
                });
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Resolve Dispute
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <RadioGroup
          label="Decision"
          value={decision}
          onValueChange={setDecision}
          options={[
            { value: 'upheld', label: 'Uphold', description: 'The review stands.' },
            { value: 'revised', label: 'Revise', description: 'Publish corrected scores as a new revision.' },
            { value: 'withdrawn', label: 'Withdraw', description: 'The review no longer applies.' },
          ]}
        />
        {decision === 'revised' ? (
          <>
            <ScoreEditor rubric={r.rubric} scores={scores} onChange={setScores} projectId={r.project.id} />
            <Field label="Factual Notes">
              <Textarea value={facts} onChange={(e) => setFacts(e.target.value)} rows={3} maxLength={20000} />
            </Field>
          </>
        ) : null}
        <Field label="Reason" required helper="At least 3 characters. Shown to the member.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Dialog>
  );
};

const ImprovementTaskDialog = ({ r, onClose }: { r: OfmQualityReview; onClose: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [title, setTitle] = useState(`Improve: ${r.rubric.name}`.slice(0, 200));
  const [description, setDescription] = useState(r.improvements ?? '');
  const [due, setDue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useOfmMutation(E.createImprovementTask, { also: ['tasks.', 'myWork.'] });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="small"
      title="Create Improvement Task"
      description={`A task for ${r.subjectMember.displayName}. No pay deductions or hidden ratings are attached.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={title.trim().length < 3}
            loading={m.isPending}
            onClick={async () => {
              setError(null);
              try {
                await m.run({ params: { workspaceId: workspace.id, reviewId: r.id }, body: { title: title.trim(), description: description.trim() || undefined, dueAt: due ? fromLocalInput(due, user.timezone) : null } });
                toast.success('Improvement task created');
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Create Task
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={4000} />
        </Field>
        <Field label="Due">
          <DateTimeInput timezone={user.timezone} value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
};

// ——— Rubrics ———

const RubricsPanel = () => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const q = useApiQuery(E.listRubrics, { params: { workspaceId: workspace.id } });
  const [creating, setCreating] = useState<OfmRubricVersion | 'new' | null>(null);
  const [publishing, setPublishing] = useState<OfmRubricVersion | null>(null);
  const publish = useOfmMutation(E.publishRubricVersion, { successMessage: 'Rubric version published' });
  const manage = can('quality.publish');
  const groups = useMemo(() => {
    const m = new Map<string, OfmRubricVersion[]>();
    for (const r of q.data ?? []) m.set(r.rubricKey, [...(m.get(r.rubricKey) ?? []), r]);
    return [...m.entries()];
  }, [q.data]);
  return (
    <div className="flex flex-col gap-4">
      {manage ? (
        <div>
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating('new')}>
            New Rubric Version
          </Button>
        </div>
      ) : null}
      <QueryState query={q}>
        {groups.length ? (
          groups.map(([key, versions]) => (
            <Panel key={key} title={versions[0]!.name} description={`Key: ${key}`}>
              <ul className="flex flex-col divide-y divide-line">
                {versions
                  .slice()
                  .sort((a, b) => b.versionNo - a.versionNo)
                  .map((v) => (
                    <li key={v.id} className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[14px] font-medium text-fg">
                          Version {v.versionNo} · {v.criteria.length} criteria
                        </span>
                        <span className="flex items-center gap-2">
                          <StatusBadge status={v.state === 'published' ? 'active' : v.state === 'retired' ? 'archived' : 'draft'} label={label('rubricState', v.state)} />
                          {manage && v.state === 'draft' ? (
                            <Button size="sm" variant="primary" onClick={() => setPublishing(v)}>
                              Publish
                            </Button>
                          ) : null}
                          {manage && v.state !== 'draft' ? (
                            <Button size="sm" onClick={() => setCreating(v)}>
                              New Version
                            </Button>
                          ) : null}
                        </span>
                      </div>
                      <ul className="flex flex-wrap gap-1.5">
                        {v.criteria.map((c) => (
                          <Badge key={c.key}>
                            {c.label} · {formatPercent(c.weight, 0)}
                          </Badge>
                        ))}
                      </ul>
                    </li>
                  ))}
              </ul>
            </Panel>
          ))
        ) : (
          <EmptyState icon={<ClipboardText size={28} />} title="No rubrics yet" description={manage ? 'Create a rubric version and publish it before drafting reviews.' : 'A quality lead publishes rubrics.'} />
        )}
      </QueryState>
      {creating ? <RubricDialog base={creating === 'new' ? undefined : creating} onClose={() => setCreating(null)} /> : null}
      <ConfirmDialog
        open={!!publishing}
        onOpenChange={(o) => !o && setPublishing(null)}
        title="Publish rubric version?"
        body="The version is frozen. The previously published version of this rubric is retired; existing reviews keep the version they were scored with."
        confirmLabel="Publish"
        loading={publish.isPending}
        onConfirm={() => void runAction(() => publish.run({ params: { workspaceId: workspace.id, rubricVersionId: publishing!.id } }, { ifMatch: publishing!.rowVersion })).then((ok) => ok && setPublishing(null))}
      />
    </div>
  );
};

const RubricDialog = ({ base, onClose }: { base?: OfmRubricVersion; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [name, setName] = useState(base?.name ?? '');
  const [key, setKey] = useState(base?.rubricKey ?? '');
  const [criteria, setCriteria] = useState(base?.criteria.map((c) => ({ ...c, description: c.description ?? '' })) ?? [{ key: '', label: '', weight: '100', description: '' }]);
  const [error, setError] = useState<string | null>(null);
  const m = useOfmMutation(E.createRubricVersion, { successMessage: 'Draft rubric version created' });
  const total = criteria.reduce((s, c) => s + (Number(c.weight) || 0), 0);
  const keyRe = /^[a-z][a-z0-9_]{1,59}$/;
  const valid = name.trim().length >= 2 && keyRe.test(key) && criteria.length > 0 && criteria.every((c) => keyRe.test(c.key) && c.label.trim().length >= 2 && Number(c.weight) > 0) && Math.abs(total - 100) < 0.0001;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="wide"
      title={base ? `New version of ${base.name}` : 'New rubric'}
      description="Weights must add up to exactly 100 %. A draft can be published later; published versions are frozen."
      dirty
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={m.isPending}
            onClick={async () => {
              setError(null);
              try {
                await m.run({
                  params: { workspaceId: workspace.id },
                  body: { name: name.trim(), rubricKey: key, criteria: criteria.map((c) => ({ key: c.key, label: c.label.trim(), weight: c.weight, description: c.description.trim() || undefined })) },
                });
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Create Draft
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Rubric Key" required helper="Lowercase letters, digits and underscores." error={key && !keyRe.test(key) ? 'Invalid key' : undefined}>
            <Input value={key} onChange={(e) => setKey(e.target.value.trim())} maxLength={60} disabled={!!base} />
          </Field>
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-[13px] font-[550] text-fg">Criteria</legend>
          {criteria.map((c, i) => (
            <div key={i} className="grid grid-cols-1 items-start gap-2 rounded-[12px] border border-line p-3 md:grid-cols-[160px_1fr_100px_auto]">
              <Input aria-label={`Criterion ${i + 1} key`} placeholder="key" value={c.key} onChange={(e) => setCriteria(criteria.map((x, n) => (n === i ? { ...x, key: e.target.value.trim() } : x)))} maxLength={60} />
              <Input aria-label={`Criterion ${i + 1} label`} placeholder="Label" value={c.label} onChange={(e) => setCriteria(criteria.map((x, n) => (n === i ? { ...x, label: e.target.value } : x)))} maxLength={80} />
              <Input aria-label={`Criterion ${i + 1} weight (percent)`} inputMode="decimal" value={c.weight} onChange={(e) => setCriteria(criteria.map((x, n) => (n === i ? { ...x, weight: e.target.value.trim() } : x)))} />
              <IconButton label="Remove criterion" icon={<Trash size={16} />} onClick={() => setCriteria(criteria.filter((_, n) => n !== i))} disabled={criteria.length === 1} />
              <div className="md:col-span-4">
                <Input aria-label={`Criterion ${i + 1} description`} placeholder="What does a 4 look like? (optional)" value={c.description} onChange={(e) => setCriteria(criteria.map((x, n) => (n === i ? { ...x, description: e.target.value } : x)))} maxLength={500} />
              </div>
            </div>
          ))}
          <p className={Math.abs(total - 100) < 0.0001 ? 'text-[12px] text-fg-2' : 'text-[12px] text-danger'}>Total weight: {total.toFixed(2)} %</p>
          {criteria.length < 20 ? (
            <div>
              <Button size="sm" icon={<Plus size={14} />} onClick={() => setCriteria([...criteria, { key: '', label: '', weight: '', description: '' }])}>
                Add Criterion
              </Button>
            </div>
          ) : null}
        </fieldset>
      </div>
    </Dialog>
  );
};
