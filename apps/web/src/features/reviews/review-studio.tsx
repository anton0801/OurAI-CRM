'use client';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  Circle,
  DotsThree,
  Keyboard,
  WarningCircle,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  contentVersionEndpoints,
  reviewEndpoints,
  type ContentVersionDetail,
  type ContentVersionFile,
  type ReviewStudioDetail,
} from '@castlane/api-contracts';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  IconButton,
  Menu,
  PageHeader,
  Panel,
  Select,
  StatusBadge,
  Switch,
  cn,
  formatDateTime,
} from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';
import { Person } from '../content/format';
import { CONTENT_BRIEF_FIELDS } from '../content/labels';
import { FileMeta, FileViewer, useFileActions, type ViewerHandle } from '../content/media-viewer';
import {
  VersionCommentComposer,
  VersionComments,
  markersFor,
  useVersionComments,
  type AnnotationDraft,
} from './review-comments';
import {
  ApproveDialog,
  AssignReviewerDialog,
  RequestChangesDialog,
  RevokeDialog,
  type ReviewTarget,
} from './review-dialogs';

type Params = 'version' | 'compare' | 'file' | 'queue';

const fileLabel = (f: ContentVersionFile) =>
  `${label('contentSlot', f.slot)}${f.position ? ` ${f.position + 1}` : ''}`;

/** The same deliverable in another version: same slot and position, else the same slot, else the first file. */
const counterpart = (files: ContentVersionFile[], f: ContentVersionFile | null) =>
  f
    ? (files.find((x) => x.slot === f.slot && x.position === f.position) ??
      files.find((x) => x.slot === f.slot) ??
      files[0] ??
      null)
    : (files[0] ?? null);

const isTyping = (el: EventTarget | null) => {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  const role = el.getAttribute('role');
  return role === 'combobox' || role === 'application' || role === 'listbox' || role === 'textbox';
};

/** The earlier version shown next to the reviewed one (read-only, with its own markers). */
const CompareSide = ({
  version,
  file,
}: {
  version: ContentVersionDetail;
  file: ContentVersionFile | null;
}) => {
  const comments = useVersionComments(version.id);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-[13px] font-semibold text-fg">
        Version {version.versionNo}{' '}
        <span className="font-normal text-fg-2">· {label('versionState', version.state)}</span>
      </h3>
      {file ? (
        <>
          <FileViewer
            file={file}
            markers={markersFor(comments.numbered, file.assetVersionId)}
            compact
            caption={`Version ${version.versionNo}, ${fileLabel(file)}`}
          />
          <FileMeta file={file} />
        </>
      ) : (
        <EmptyState
          title="Not in this version"
          description="The earlier version had no file in this slot."
          className="py-6"
        />
      )}
    </div>
  );
};

/** S26 Review Studio for one review; loads the review, then the studio. */
export const ReviewStudio = ({ reviewId }: { reviewId: string }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(reviewEndpoints.get, { params: { workspaceId: workspace.id, reviewId } });
  return <QueryState query={q}>{q.data ? <Studio review={q.data} /> : null}</QueryState>;
};

/**
 * Review Studio: 2/3 media, 1/3 decision and comments. The version under review is exact — the
 * decision always names it (T042); other versions can be viewed or compared side by side, each
 * with its own comments and coordinates (T046). Everything is reachable by keyboard (T166):
 * skip links, shortcuts (C comment, [ ] files, D decision), keyboard point pinning, and focus
 * moves to the decision status after a decision.
 */
const Studio = ({ review }: { review: ReviewStudioDetail }) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state, set } = useUrlState<Params>();
  const actions = useFileActions();
  const content = review.content;
  const submitted = useMemo(() => review.versions.filter((v) => v.submittedAt), [review.versions]);
  const viewedId =
    state.version && submitted.some((v) => v.id === state.version) ? state.version : review.version.id;
  const other = useApiQuery(
    contentVersionEndpoints.get,
    { params: { workspaceId: workspace.id, contentId: content.id, versionId: viewedId } },
    { enabled: viewedId !== review.version.id },
  );
  const viewed: ContentVersionDetail | null =
    viewedId === review.version.id ? review.version : (other.data ?? null);
  const viewingOther = viewedId !== review.version.id;
  const viewedIdx = submitted.findIndex((v) => v.id === viewedId);
  const previous = viewedIdx >= 0 ? (submitted[viewedIdx + 1] ?? null) : null;
  const compare = state.compare === '1' && !!previous;
  const prev = useApiQuery(
    contentVersionEndpoints.get,
    { params: { workspaceId: workspace.id, contentId: content.id, versionId: previous?.id ?? viewedId } },
    { enabled: compare && !!previous },
  );

  const files = viewed?.files ?? [];
  const file = files.find((f) => f.assetVersionId === state.file) ?? files[0] ?? null;
  const [draft, setDraft] = useState<AnnotationDraft>({ file: null, point: null, placing: false });
  const [active, setActive] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(true);
  const [dialog, setDialog] = useState<'approve' | 'changes' | 'revoke' | 'assign' | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const viewer = useRef<ViewerHandle>(null);
  const decisionHeading = useRef<HTMLHeadingElement>(null);
  const comments = useVersionComments(viewed?.id ?? review.version.id);
  const reviewComments = useVersionComments(review.version.id);
  const openComments = reviewComments.q.data
    ? reviewComments.numbered.filter(({ thread }) => !thread.removed && thread.state !== 'resolved').length
    : null;

  useEffect(() => {
    setDraft({ file: null, point: null, placing: false });
    setActive(null);
  }, [viewedId]);

  const queue = (state.queue ?? '').split(',').filter(Boolean);
  const queueIdx = queue.indexOf(review.id);
  const queueHref = (id: string) => `${wsPath(`/reviews/${id}`)}?queue=${queue.join(',')}`;

  const target: ReviewTarget = {
    id: review.id,
    rowVersion: review.rowVersion,
    versionId: review.version.id,
    versionNo: review.version.versionNo,
    title: content.title,
    projectId: content.project.id,
    reviewerMembershipId: review.reviewer?.membershipId ?? null,
  };
  const selfReview = review.approveBlockers.some((b) => b.code === 'SELF_REVIEW');
  const otherBlockers = review.approveBlockers.filter(
    (b) => b.code !== 'SELF_REVIEW' || !review.permissions.selfReviewException,
  );
  const stepIdx = review.steps.indexOf(review.stepKind);
  const nextStep = stepIdx >= 0 && stepIdx < review.steps.length - 1 ? review.steps[stepIdx + 1] : null;
  const nextPending = review.version.reviews.find((r) => r.id !== review.id && r.status === 'pending');
  const versionNoOf = (id: string) => review.versions.find((v) => v.id === id)?.versionNo;

  /** After a decision the buttons change: focus lands on the decision status, never on <body>. */
  const focusDecision = () => window.setTimeout(() => decisionHeading.current?.focus(), 80);

  const selectFile = (dir: 1 | -1) => {
    if (files.length < 2) return;
    const i = Math.max(
      0,
      files.findIndex((f) => f.assetVersionId === file?.assetVersionId),
    );
    const next = files[(i + dir + files.length) % files.length]!;
    set({ file: next.assetVersionId });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (e.key === 'c' && viewed && review.permissions.comment) {
        e.preventDefault();
        document.getElementById(`comment-composer-${viewed.id}`)?.focus();
      } else if (e.key === ']') {
        e.preventDefault();
        selectFile(1);
      } else if (e.key === '[') {
        e.preventDefault();
        selectFile(-1);
      } else if (e.key === 'd') {
        e.preventDefault();
        decisionHeading.current?.focus();
      } else if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const versionOptions = submitted.map((v) => ({
    value: v.id,
    label: `Version ${v.versionNo}${v.id === review.version.id ? ' · this review' : ''}${v.isLatest ? ' · latest' : ''}${v.isApproved ? ' · approved' : ''}`,
    description: `${label('versionState', v.state)}${v.submittedAt ? ` · submitted ${formatDateTime(v.submittedAt, user.timezone)}` : ''}`,
  }));

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Skip links" className="flex gap-2">
        <a
          href="#review-decision"
          className="sr-only rounded-[8px] bg-surface px-3 py-2 text-[13px] font-medium text-fg focus:not-sr-only focus:outline-2 focus:outline-[var(--c-focus)]"
        >
          Skip to decision
        </a>
        <a
          href="#review-comments"
          className="sr-only rounded-[8px] bg-surface px-3 py-2 text-[13px] font-medium text-fg focus:not-sr-only focus:outline-2 focus:outline-[var(--c-focus)]"
        >
          Skip to comments
        </a>
      </nav>
      <PageHeader
        crumbs={[
          { label: 'Review Queue', href: wsPath('/reviews') },
          { label: content.project.name },
          { label: content.title },
        ]}
        title={`Review: ${content.title}`}
        meta={
          <>
            <StatusBadge status={review.status} label={label('reviewStatus', review.status)} />
            <Badge>Version {review.version.versionNo}</Badge>
            <Badge>Round {review.roundNo}</Badge>
            {review.steps.length > 1 ? (
              <Badge tone="info">{`Step ${stepIdx + 1} of ${review.steps.length}: ${label('reviewStep', review.stepKind)}`}</Badge>
            ) : null}
            {review.overdue ? <StatusBadge status="overdue" label="Overdue" /> : null}
            {review.selfReviewException ? <Badge tone="warning">Self-review exception</Badge> : null}
          </>
        }
        description={`${label('contentFormat', content.format)} · submitted by ${review.author?.displayName ?? 'unknown'} ${formatDateTime(review.submittedAt, user.timezone)}${review.dueAt ? ` · due ${formatDateTime(review.dueAt, user.timezone)}` : ''}`}
        actions={
          <>
            {queue.length > 1 && queueIdx >= 0 ? (
              <div className="flex items-center gap-1" role="group" aria-label="Selected reviews">
                <IconButton
                  label="Previous review"
                  icon={<ArrowLeft size={16} />}
                  disabled={queueIdx === 0}
                  onClick={() => router.push(queueHref(queue[queueIdx - 1]!))}
                />
                <span className="px-1 text-[13px] text-fg-2">
                  Review {queueIdx + 1} of {queue.length}
                </span>
                <IconButton
                  label="Next review"
                  icon={<ArrowRight size={16} />}
                  disabled={queueIdx === queue.length - 1}
                  onClick={() => router.push(queueHref(queue[queueIdx + 1]!))}
                />
              </div>
            ) : null}
            <Button
              onClick={() =>
                router.push(wsPath(`/content/${content.id}?tab=versions&version=${review.version.id}`))
              }
            >
              Open Content
            </Button>
            <Menu
              label="More review actions"
              trigger={
                <IconButton
                  label="More review actions"
                  icon={<DotsThree size={18} weight="bold" />}
                  variant="secondary"
                />
              }
              items={[
                {
                  label: 'Open Original',
                  hidden: !file?.canDownload || file.status !== 'available',
                  onSelect: () => file && void actions.open(file),
                },
                {
                  label: 'Download File',
                  hidden: !file?.canDownload || file.status !== 'available' || !review.permissions.download,
                  onSelect: () => file && void actions.download(file),
                },
                {
                  label: 'Keyboard Shortcuts',
                  onSelect: () => setShortcutsOpen(true),
                  separatorBefore: true,
                },
                { label: 'Review Queue', href: wsPath('/reviews') },
              ]}
            />
          </>
        }
      />

      {review.status === 'pending' && !review.isCurrentTarget ? (
        <Banner
          tone="warning"
          action={
            <Button
              size="sm"
              onClick={() =>
                router.push(
                  wsPath(
                    `/content/${content.id}?tab=versions${content.currentVersion ? `&version=${content.currentVersion.id}` : ''}`,
                  ),
                )
              }
            >
              Open Latest Version
            </Button>
          }
        >
          A newer version was submitted. This review no longer decides the latest version.
        </Banner>
      ) : null}
      {viewingOther && viewed ? (
        <Banner
          tone="info"
          action={
            <Button size="sm" onClick={() => set({ version: null, file: null, compare: null })}>
              Back to Version {review.version.versionNo}
            </Button>
          }
        >
          You are viewing version {viewed.versionNo}. This review decides version {review.version.versionNo}.
        </Banner>
      ) : null}
      {review.version.approvalRevokedAt ? (
        <Banner tone="danger">
          Approval of version {review.version.versionNo} was revoked{' '}
          {formatDateTime(review.version.approvalRevokedAt, user.timezone)}:{' '}
          {review.version.approvalRevokedReason}
        </Banner>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section aria-label="Media" className="flex min-w-0 flex-col gap-3 xl:col-span-2">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-[320px]">
              <Select
                aria-label="Version"
                value={viewedId}
                onChange={(v) => set({ version: v === review.version.id ? null : v, file: null })}
                options={versionOptions}
              />
            </div>
            <Switch
              label={previous ? `Compare with version ${previous.versionNo}` : 'Compare with previous'}
              checked={compare}
              disabled={!previous}
              onCheckedChange={(v) => set({ compare: v ? '1' : null })}
            />
          </div>
          {files.length > 1 ? (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Files of this version">
              {files.map((f) => (
                <Button
                  key={f.id}
                  size="sm"
                  variant={file?.id === f.id ? 'secondary' : 'ghost'}
                  aria-pressed={file?.id === f.id}
                  onClick={() => set({ file: f.assetVersionId })}
                >
                  {fileLabel(f)}
                </Button>
              ))}
            </div>
          ) : null}
          {!viewed ? (
            <QueryState query={other}>{null}</QueryState>
          ) : file ? (
            compare ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {prev.data ? (
                  <CompareSide version={prev.data} file={counterpart(prev.data.files, file)} />
                ) : (
                  <QueryState query={prev}>{null}</QueryState>
                )}
                <div className="flex min-w-0 flex-col gap-2">
                  <h3 className="text-[13px] font-semibold text-fg">
                    Version {viewed.versionNo}{' '}
                    <span className="font-normal text-fg-2">· {label('versionState', viewed.state)}</span>
                  </h3>
                  <FileViewer
                    ref={viewer}
                    file={file}
                    compact
                    markers={markersFor(comments.numbered, file.assetVersionId)}
                    activeMarkerId={active}
                    onSelectMarker={setActive}
                    placing={draft.placing && draft.file?.assetVersionId === file.assetVersionId}
                    pendingPoint={draft.file?.assetVersionId === file.assetVersionId ? draft.point : null}
                    onPlacePoint={(p) => setDraft({ ...draft, point: p, placing: false })}
                    onCancelPlacing={() => setDraft({ ...draft, placing: false })}
                    caption={`Version ${viewed.versionNo}, ${fileLabel(file)}`}
                  />
                  <FileMeta file={file} />
                </div>
              </div>
            ) : (
              <>
                <FileViewer
                  ref={viewer}
                  file={file}
                  markers={markersFor(comments.numbered, file.assetVersionId)}
                  activeMarkerId={active}
                  onSelectMarker={setActive}
                  placing={draft.placing && draft.file?.assetVersionId === file.assetVersionId}
                  pendingPoint={draft.file?.assetVersionId === file.assetVersionId ? draft.point : null}
                  onPlacePoint={(p) => setDraft({ ...draft, point: p, placing: false })}
                  onCancelPlacing={() => setDraft({ ...draft, placing: false })}
                  caption={`${content.title}, version ${viewed.versionNo}, ${fileLabel(file)}`}
                />
                <FileMeta file={file} />
              </>
            )
          ) : (
            <EmptyState
              title="No files"
              description={
                content.format === 'text_post'
                  ? 'This text post was submitted with its caption draft (see the brief below).'
                  : 'This version has no files.'
              }
            />
          )}

          {viewed && (viewed.note || viewed.fixesClaimed) ? (
            <Panel title="From the author">
              <dl className="flex flex-col gap-3 text-[14px]">
                {viewed.fixesClaimed ? (
                  <div>
                    <dt className="text-[12px] font-[550] text-fg-2">What was fixed</dt>
                    <dd className="whitespace-pre-wrap text-fg">{viewed.fixesClaimed}</dd>
                  </div>
                ) : null}
                {viewed.note ? (
                  <div>
                    <dt className="text-[12px] font-[550] text-fg-2">Version note</dt>
                    <dd className="whitespace-pre-wrap text-fg">{viewed.note}</dd>
                  </div>
                ) : null}
              </dl>
            </Panel>
          ) : null}
          {viewed?.checklist.length ? (
            <Panel title="Checklist">
              <ul className="flex flex-col gap-1.5 text-[14px]">
                {viewed.checklist.map((c, i) => (
                  <li key={`${c.label}-${i}`} className="flex items-center gap-2">
                    {c.done ? (
                      <CheckCircle size={16} weight="fill" className="text-primary" aria-hidden />
                    ) : (
                      <Circle size={16} className="text-fg-muted" aria-hidden />
                    )}
                    <span className={c.done ? 'text-fg' : 'text-fg-2'}>{c.label}</span>
                    <span className="sr-only">{c.done ? '(done)' : '(not done)'}</span>
                    {c.mandatory ? <span className="text-[12px] text-fg-muted">Required</span> : null}
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
          <Panel
            title={viewed?.briefSnapshot ? 'Brief at submission' : 'Brief'}
            description={
              viewed?.briefSnapshot
                ? 'Frozen with the version; later brief edits do not change it.'
                : undefined
            }
          >
            {(() => {
              const brief = viewed?.briefSnapshot ?? content.brief;
              const fields = CONTENT_BRIEF_FIELDS.filter((f) => brief[f.key]);
              return fields.length ? (
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {fields.map((f) => (
                    <div key={f.key} className={f.long ? 'sm:col-span-2' : undefined}>
                      <dt className="text-[12px] font-[550] text-fg-2">{f.label}</dt>
                      <dd className="whitespace-pre-wrap text-[14px] text-fg">{brief[f.key]}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-[14px] text-fg-2">No brief was written.</p>
              );
            })()}
            {viewed?.characterVersions.length ? (
              <p className="mt-3 text-[13px] text-fg-2">
                Characters:{' '}
                {viewed.characterVersions
                  .map((c) => `${c.name ?? 'Character'}${c.versionNo ? ` v${c.versionNo}` : ''}`)
                  .join(', ')}
              </p>
            ) : null}
          </Panel>
        </section>

        <aside aria-label="Decision and comments" className="flex min-w-0 flex-col gap-4">
          <section
            id="review-decision"
            aria-labelledby="review-decision-title"
            className="flex flex-col gap-3 rounded-[12px] border border-line bg-surface p-4"
          >
            <h2
              id="review-decision-title"
              ref={decisionHeading}
              tabIndex={-1}
              className="text-[16px] font-semibold text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)]"
            >
              Decision: {label('reviewStatus', review.status)}
            </h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
              <dt className="text-fg-2">Reviewer</dt>
              <dd className="min-w-0">
                <Person member={review.reviewer} empty="Not assigned" />
              </dd>
              <dt className="text-fg-2">Author</dt>
              <dd className="min-w-0">
                <Person member={review.author} empty="Unknown" />
              </dd>
              {review.decidedAt ? (
                <>
                  <dt className="text-fg-2">Decided</dt>
                  <dd>{formatDateTime(review.decidedAt, user.timezone)}</dd>
                </>
              ) : null}
            </dl>
            {review.steps.length > 1 ? (
              <ol className="flex flex-col gap-1 text-[13px]" aria-label="Review steps">
                {review.steps.map((s, i) => (
                  <li
                    key={s}
                    className={cn(
                      'flex items-center gap-2',
                      i === stepIdx ? 'font-semibold text-fg' : 'text-fg-2',
                    )}
                    aria-current={i === stepIdx ? 'step' : undefined}
                  >
                    {i < stepIdx ? (
                      <CheckCircle size={14} weight="fill" className="text-primary" aria-hidden />
                    ) : (
                      <Circle size={14} aria-hidden />
                    )}
                    {i + 1}. {label('reviewStep', s)}
                  </li>
                ))}
              </ol>
            ) : null}
            {nextPending ? (
              <Banner
                tone="info"
                action={
                  <Button size="sm" onClick={() => router.push(wsPath(`/reviews/${nextPending.id}`))}>
                    Open {label('reviewStep', nextPending.stepKind)}
                  </Button>
                }
              >
                {label('reviewStep', nextPending.stepKind)} is waiting for a decision.
              </Banner>
            ) : null}
            {review.status === 'pending' && otherBlockers.length ? (
              <ul
                className="flex flex-col gap-1 text-[13px] text-fg"
                aria-label="Why approval is not possible"
              >
                {otherBlockers.map((b) => (
                  <li key={b.code} className="flex items-start gap-2">
                    <WarningCircle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden />
                    {b.message}
                  </li>
                ))}
              </ul>
            ) : null}
            {review.status === 'pending' ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  disabled={!review.permissions.approve}
                  onClick={() => setDialog('approve')}
                >
                  Approve Version {review.version.versionNo}
                </Button>
                {review.permissions.requestChanges ? (
                  <Button onClick={() => setDialog('changes')}>Request Changes</Button>
                ) : null}
                {review.permissions.assign ? (
                  <Button variant="ghost" onClick={() => setDialog('assign')}>
                    Assign Reviewer
                  </Button>
                ) : null}
              </div>
            ) : null}
            {review.permissions.revoke ? (
              <div>
                <Button variant="danger-secondary" onClick={() => setDialog('revoke')}>
                  Revoke Approval
                </Button>
              </div>
            ) : null}
            {review.decisions.length ? (
              <details className="text-[13px]">
                <summary className="cursor-pointer font-medium text-fg">
                  Decision history ({review.decisions.length})
                </summary>
                <ol className="mt-2 flex flex-col gap-2">
                  {review.decisions.map((d) => (
                    <li key={d.id} className="rounded-[8px] border border-line p-2">
                      <span className="font-semibold">{label('reviewDecision', d.decision)}</span>
                      {versionNoOf(d.versionId) ? ` · version ${versionNoOf(d.versionId)}` : ''} ·{' '}
                      {d.by?.displayName ?? 'a reviewer'} · {formatDateTime(d.at, user.timezone)}
                      {d.summary ? <p className="mt-1 whitespace-pre-wrap text-fg-2">{d.summary}</p> : null}
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </section>

          {shortcutsOpen ? (
            <section
              aria-labelledby="review-shortcuts-title"
              className="rounded-[12px] border border-line bg-surface p-4 text-[13px]"
            >
              <div className="mb-2 flex items-center justify-between">
                <h2 id="review-shortcuts-title" className="flex items-center gap-2 font-semibold text-fg">
                  <Keyboard size={16} aria-hidden /> Keyboard shortcuts
                </h2>
                <Button size="sm" variant="ghost" onClick={() => setShortcutsOpen(false)}>
                  Hide
                </Button>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-fg-2">
                <dt>
                  <kbd>C</kbd>
                </dt>
                <dd>Write a comment</dd>
                <dt>
                  <kbd>[</kbd> <kbd>]</kbd>
                </dt>
                <dd>Previous / next file</dd>
                <dt>
                  <kbd>D</kbd>
                </dt>
                <dd>Go to the decision</dd>
                <dt>Arrows, Enter, Esc</dt>
                <dd>Move, pin or cancel a point while pinning</dd>
                <dt>
                  <kbd>Ctrl</kbd>+<kbd>Enter</kbd>
                </dt>
                <dd>Send the comment</dd>
                <dt>
                  <kbd>?</kbd>
                </dt>
                <dd>Show or hide this list</dd>
              </dl>
            </section>
          ) : null}

          <div id="review-comments" className="flex flex-col gap-3">
            {viewed && review.permissions.comment ? (
              <VersionCommentComposer
                key={viewed.id}
                versionId={viewed.id}
                files={viewed.files}
                selectedFile={file}
                draft={draft}
                onDraftChange={setDraft}
                currentTimeMs={() => viewer.current?.currentTimeMs() ?? null}
                onCreated={(c) => setActive(c.id)}
              />
            ) : null}
            {viewed ? (
              <VersionComments
                versionId={viewed.id}
                files={viewed.files}
                data={comments}
                activeId={active}
                showResolved={showResolved}
                onShowResolvedChange={setShowResolved}
                title={viewingOther ? `Comments on version ${viewed.versionNo}` : 'Comments'}
                onSelect={(t) => {
                  if (t.assetVersionId && t.assetVersionId !== file?.assetVersionId)
                    set({ file: t.assetVersionId });
                  setActive(t.id);
                  if (t.timecodeMs !== null) viewer.current?.seek(t.timecodeMs);
                }}
              />
            ) : null}
          </div>
        </aside>
      </div>

      <ApproveDialog
        open={dialog === 'approve'}
        onOpenChange={(o) => setDialog(o ? 'approve' : null)}
        review={target}
        selfReview={selfReview}
        exceptionAvailable={review.permissions.selfReviewException}
        nextStepLabel={nextStep ? label('reviewStep', nextStep) : null}
        onDone={focusDecision}
      />
      <RequestChangesDialog
        open={dialog === 'changes'}
        onOpenChange={(o) => setDialog(o ? 'changes' : null)}
        review={target}
        openComments={openComments}
        onDone={focusDecision}
      />
      <RevokeDialog
        open={dialog === 'revoke'}
        onOpenChange={(o) => setDialog(o ? 'revoke' : null)}
        review={target}
        onDone={focusDecision}
      />
      <AssignReviewerDialog
        open={dialog === 'assign'}
        onOpenChange={(o) => setDialog(o ? 'assign' : null)}
        review={target}
        onDone={focusDecision}
      />
    </div>
  );
};
