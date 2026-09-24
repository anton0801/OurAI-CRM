'use client';
import {
  ArrowBendUpLeft,
  ChatCircle,
  CheckCircle,
  ClockCounterClockwise,
  Clock,
  MapPin,
  PencilSimple,
  Trash,
  X,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  commentEndpoints,
  type CommentThread,
  type CommentView,
  type ContentVersionFile,
} from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS } from '@castlane/domain';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  RadioGroup,
  Select,
  Switch,
  Textarea,
  cn,
  formatDateTime,
  formatRelative,
  toast,
} from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { formatMs } from '../content/format';
import type { AnnotationMarker } from '../content/media-viewer';
import '../content/labels';

const INVALIDATE = ['comments.', 'reviews.get', 'content.versions.'];
type Severity = 'note' | 'issue' | 'blocking';

const SEVERITY_TONE = { note: 'neutral', issue: 'warning', blocking: 'danger' } as const;

/** Parse "m:ss", "h:mm:ss" or plain seconds into milliseconds. */
export const parseTimecode = (v: string): number | null => {
  const t = v.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  const parts = t.split(':').map((x) => x.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  const [h, m, s] = nums.length === 3 ? nums : [0, nums[0]!, nums[1]!];
  if (m! >= 60 || s! >= 60) return null;
  return Math.round(((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) * 1000);
};

/** Threads of one version, numbered for their markers (root comments in creation order; numbers stay stable). */
export const useVersionComments = (versionId: string) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(commentEndpoints.list, {
    params: { workspaceId: workspace.id },
    query: { parentType: 'content_version', parentId: versionId, includeResolved: true },
  });
  const numbered = useMemo(
    () => (q.data?.threads ?? []).map((t, i) => ({ thread: t, index: i + 1 })),
    [q.data],
  );
  return { q, numbered };
};

export const markersFor = (
  numbered: { thread: CommentThread; index: number }[],
  assetVersionId: string | null,
): AnnotationMarker[] =>
  numbered
    .filter(
      ({ thread }) => !thread.removed && thread.assetVersionId && thread.assetVersionId === assetVersionId,
    )
    .map(({ thread, index }) => ({
      id: thread.id,
      index,
      pointX: thread.pointX,
      pointY: thread.pointY,
      timecodeMs: thread.timecodeMs,
      severity: thread.severity,
      resolved: thread.state === 'resolved',
    }));

export interface AnnotationDraft {
  file: ContentVersionFile | null;
  point: { x: number; y: number } | null;
  placing: boolean;
}

/** Composer for a version comment: severity, optional anchor on a file (image point or timecode). */
export const VersionCommentComposer = ({
  versionId,
  files,
  selectedFile,
  draft,
  onDraftChange,
  currentTimeMs,
  onCreated,
  disabled,
}: {
  versionId: string;
  files: ContentVersionFile[];
  selectedFile: ContentVersionFile | null;
  draft: AnnotationDraft;
  onDraftChange: (d: AnnotationDraft) => void;
  currentTimeMs?: () => number | null;
  onCreated?: (c: CommentView) => void;
  disabled?: boolean;
}) => {
  const { workspace } = useWorkspace();
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<Severity>('note');
  const [anchorFileId, setAnchorFileId] = useState<string | null>(null);
  const [timecode, setTimecode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pinButton = useRef<HTMLButtonElement>(null);
  const wasPlacing = useRef(false);
  // When a point is pinned (or placing is cancelled) focus returns to the pin control (T166).
  useEffect(() => {
    if (wasPlacing.current && !draft.placing) pinButton.current?.focus();
    wasPlacing.current = draft.placing;
  }, [draft.placing]);
  const create = useApiMutation(commentEndpoints.create, { invalidate: INVALIDATE, silentErrors: true });
  const anchor = files.find((f) => f.assetVersionId === anchorFileId) ?? null;
  // Follow the file shown in the viewer unless the member picked another anchor.
  useEffect(() => {
    if (!anchorFileId && selectedFile && draft.point) setAnchorFileId(selectedFile.assetVersionId);
  }, [draft.point, selectedFile, anchorFileId]);

  const timed = anchor && (anchor.kind === 'video' || anchor.kind === 'audio');
  const image = anchor && anchor.kind === 'image';
  const submit = async () => {
    setError(null);
    const tc = timed && timecode.trim() ? parseTimecode(timecode) : null;
    if (timed && timecode.trim() && tc === null) {
      setError('Enter the timecode as m:ss, for example 1:05.');
      return;
    }
    if (
      tc !== null &&
      anchor?.durationMs !== null &&
      anchor?.durationMs !== undefined &&
      tc > anchor.durationMs
    ) {
      setError(`The timecode must be between 0:00 and ${formatMs(anchor.durationMs)}.`);
      return;
    }
    try {
      const c = await create.run({
        params: { workspaceId: workspace.id },
        body: {
          parentType: 'content_version',
          parentId: versionId,
          body: body.trim(),
          severity,
          targetVersionId: versionId,
          ...(anchor ? { assetVersionId: anchor.assetVersionId } : {}),
          ...(tc !== null ? { timecodeMs: tc } : {}),
          ...(image && draft.point
            ? { pointX: draft.point.x.toFixed(5), pointY: draft.point.y.toFixed(5) }
            : {}),
        },
      });
      setBody('');
      setTimecode('');
      setSeverity('note');
      onDraftChange({ file: null, point: null, placing: false });
      toast.success('Comment added');
      onCreated?.(c);
      textarea.current?.focus();
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The comment was not saved.');
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-[12px] border border-line bg-surface p-3">
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <Field label="Add Comment">
        <Textarea
          ref={textarea}
          id={`comment-composer-${versionId}`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={LIMITS.commentMax}
          disabled={disabled}
          placeholder="What should change? Be specific."
          className="min-h-[72px]"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) void submit();
          }}
        />
      </Field>
      <RadioGroup
        label="Severity"
        orientation="horizontal"
        value={severity}
        onValueChange={setSeverity}
        options={[
          { value: 'note', label: 'Note' },
          { value: 'issue', label: 'Issue' },
          { value: 'blocking', label: 'Blocker', description: 'Blocks approval until resolved.' },
        ]}
      />
      {files.length ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="About file">
            <Select
              value={anchorFileId}
              clearable
              placeholder="The whole version"
              onChange={(v) => {
                setAnchorFileId(v);
                onDraftChange({ ...draft, point: null, placing: false });
              }}
              options={files.map((f) => ({
                value: f.assetVersionId,
                label: `${label('contentSlot', f.slot)} · ${f.fileName}`,
              }))}
            />
          </Field>
          {timed ? (
            <Field
              label="Timecode"
              helper={
                anchor?.durationMs !== null && anchor?.durationMs !== undefined
                  ? `0:00 – ${formatMs(anchor.durationMs)}`
                  : 'Duration unknown: timecodes cannot be checked.'
              }
            >
              <div className="flex gap-2">
                <input
                  className="h-10 w-full min-w-0 rounded-[8px] border border-line bg-surface px-3 font-mono text-[14px] text-fg focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]"
                  value={timecode}
                  onChange={(e) => setTimecode(e.target.value)}
                  placeholder="m:ss"
                  aria-label="Timecode"
                />
                {currentTimeMs ? (
                  <Button
                    size="sm"
                    icon={<Clock size={14} />}
                    onClick={() => {
                      const ms = currentTimeMs();
                      if (ms === null) toast.info('Play the file first to use its current time.');
                      else setTimecode(formatMs(ms));
                    }}
                  >
                    Use Current Time
                  </Button>
                ) : null}
              </div>
            </Field>
          ) : image ? (
            <div className="flex flex-col justify-end gap-1">
              <Button
                ref={pinButton}
                size="sm"
                icon={<MapPin size={14} />}
                aria-pressed={draft.placing}
                disabled={selectedFile?.assetVersionId !== anchor?.assetVersionId}
                onClick={() => onDraftChange({ file: anchor, point: draft.point, placing: !draft.placing })}
              >
                {draft.placing ? 'Stop Pinning' : draft.point ? 'Move Pin' : 'Pin a Point'}
              </Button>
              <span className="text-[12px] text-fg-2">
                {selectedFile?.assetVersionId !== anchor?.assetVersionId
                  ? 'Show this image in the viewer to pin a point.'
                  : draft.point
                    ? `Pinned at ${Math.round(draft.point.x * 100)}% × ${Math.round(draft.point.y * 100)}%.`
                    : 'Click the image or use the arrow keys and Enter.'}
              </span>
              {draft.point ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<X size={12} />}
                  onClick={() => onDraftChange({ ...draft, point: null })}
                >
                  Remove Pin
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button
          variant="primary"
          size="sm"
          disabled={!body.trim() || disabled}
          loading={create.isPending}
          onClick={() => void submit()}
        >
          Add Comment
        </Button>
      </div>
    </div>
  );
};

const AnchorChip = ({
  c,
  files,
  onSelect,
}: {
  c: CommentView;
  files: ContentVersionFile[];
  onSelect?: () => void;
}) => {
  const f = files.find((x) => x.assetVersionId === c.assetVersionId);
  if (!c.assetVersionId) return null;
  const text =
    c.timecodeMs !== null
      ? `${formatMs(c.timecodeMs)}`
      : c.pointX !== null
        ? `${Math.round(Number(c.pointX) * 100)}% × ${Math.round(Number(c.pointY) * 100)}%`
        : null;
  const content = (
    <>
      {c.timecodeMs !== null ? <Clock size={12} aria-hidden /> : <MapPin size={12} aria-hidden />}
      {f ? label('contentSlot', f.slot) : 'Earlier file'}
      {text ? ` · ${text}` : ''}
    </>
  );
  return onSelect ? (
    <button
      type="button"
      onClick={onSelect}
      className="inline-flex items-center gap-1 rounded-[6px] border border-line px-1.5 text-[12px] text-fg-2 hover:bg-surface-2"
      aria-label={`Show on ${f ? label('contentSlot', f.slot) : 'file'}${text ? ` at ${text}` : ''}`}
    >
      {content}
    </button>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-[6px] border border-line px-1.5 text-[12px] text-fg-2">
      {content}
    </span>
  );
};

const CommentBlock = ({
  c,
  index,
  files,
  onChanged,
  onReply,
  onSelectAnchor,
  active,
}: {
  c: CommentView;
  index?: number;
  files: ContentVersionFile[];
  onChanged: () => void;
  onReply?: () => void;
  onSelectAnchor?: () => void;
  active?: boolean;
}) => {
  const { workspace, user } = useWorkspace();
  const params = { workspaceId: workspace.id, commentId: c.id };
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.body ?? '');
  const [removeOpen, setRemoveOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [note, setNote] = useState('');
  const [conflict, setConflict] = useState(false);
  const update = useApiMutation(commentEndpoints.update, {
    invalidate: INVALIDATE,
    successMessage: 'Comment updated',
    silentErrors: true,
  });
  const resolve = useApiMutation(commentEndpoints.resolve, {
    invalidate: INVALIDATE,
    successMessage: 'Marked as resolved',
  });
  const reopen = useApiMutation(commentEndpoints.reopen, {
    invalidate: INVALIDATE,
    successMessage: 'Thread reopened',
  });
  const remove = useApiMutation(commentEndpoints.remove, {
    invalidate: INVALIDATE,
    successMessage: 'Comment removed',
  });
  return (
    <article
      id={`comment-${c.id}`}
      tabIndex={-1}
      className={cn(
        'flex gap-3 rounded-[8px] p-1 focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]',
        active && 'bg-selection',
      )}
      aria-label={`${index ? `Comment ${index}` : 'Reply'} by ${c.author.displayName}`}
    >
      <Avatar name={c.author.displayName} src={c.author.avatarUrl ?? null} size={28} decorative />
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-2">
          {index ? <span className="font-mono font-semibold text-fg">#{index}</span> : null}
          <span className="font-semibold text-fg">{c.author.displayName}</span>
          <time dateTime={c.createdAt} title={formatDateTime(c.createdAt, user.timezone)}>
            {formatRelative(c.createdAt)}
          </time>
          {c.depth === 0 ? (
            <Badge tone={SEVERITY_TONE[c.severity]}>{label('commentSeverity', c.severity)}</Badge>
          ) : null}
          {c.state === 'resolved' ? (
            <Badge tone="success" icon={<CheckCircle size={12} aria-hidden />}>
              Resolved
            </Badge>
          ) : null}
          {c.state === 'reopened' ? <Badge tone="warning">Reopened</Badge> : null}
          {c.editedAt ? <span>Edited</span> : null}
          <AnchorChip c={c} files={files} onSelect={onSelectAnchor} />
        </header>
        {editing ? (
          <div className="mt-2 flex flex-col gap-2">
            <Field label="Edit comment" hideLabel>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={LIMITS.commentMax}
                autoFocus
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={update.isPending}
                disabled={!text.trim()}
                onClick={async () => {
                  try {
                    await update.run({ params, body: { body: text.trim() } }, { ifMatch: c.rowVersion });
                    setEditing(false);
                    onChanged();
                  } catch (e) {
                    if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
                    else toast.error(isApiError(e) ? e.message : 'The comment was not saved.');
                  }
                }}
              >
                Save
              </Button>
            </div>
          </div>
        ) : c.removed ? (
          <p className="mt-1 text-[14px] italic text-fg-muted">This comment was removed.</p>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-[22px] text-fg">{c.body}</p>
        )}
        {c.resolutionNote && c.state === 'resolved' ? (
          <p className="mt-1 text-[12px] text-fg-2">Resolution: {c.resolutionNote}</p>
        ) : null}
        {!editing ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {c.permissions.reply && onReply ? (
              <Button size="sm" variant="ghost" icon={<ArrowBendUpLeft size={14} />} onClick={onReply}>
                Reply
              </Button>
            ) : null}
            {c.permissions.resolve ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<CheckCircle size={14} />}
                onClick={() => setResolveOpen(true)}
              >
                Resolve
              </Button>
            ) : null}
            {c.permissions.reopen ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<ClockCounterClockwise size={14} />}
                onClick={() => setReopenOpen(true)}
              >
                Reopen
              </Button>
            ) : null}
            {c.permissions.edit ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<PencilSimple size={14} />}
                onClick={() => {
                  setText(c.body ?? '');
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            ) : null}
            {c.permissions.remove ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Trash size={14} />}
                onClick={() => setRemoveOpen(true)}
              >
                Remove Comment
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={resolveOpen}
        onOpenChange={(o) => {
          setResolveOpen(o);
          if (!o) setNote('');
        }}
        title="Resolve this thread?"
        body="Resolving records that the issue was fixed. A reviewer can reopen it."
        confirmLabel="Resolve"
        loading={resolve.isPending}
        onConfirm={async () => {
          await resolve.run(
            { params, body: { resolutionNote: note.trim() || undefined } },
            { ifMatch: c.rowVersion },
          );
          setResolveOpen(false);
          setNote('');
          onChanged();
        }}
      >
        <Field label="What was fixed (optional)">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={LIMITS.reasonMax} />
        </Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={reopenOpen}
        onOpenChange={(o) => {
          setReopenOpen(o);
          if (!o) setNote('');
        }}
        title="Reopen this thread?"
        body="A reopened blocker blocks approval again. Explain what still needs attention."
        confirmLabel="Reopen"
        loading={reopen.isPending}
        confirmDisabled={note.trim().length < 3}
        onConfirm={async () => {
          await reopen.run({ params, body: { reason: note.trim() } }, { ifMatch: c.rowVersion });
          setReopenOpen(false);
          setNote('');
          onChanged();
        }}
      >
        <Field label="Reason" required>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={LIMITS.reasonMax} />
        </Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove this comment?"
        body="The text is hidden for everyone. The fact that a comment existed stays in the record."
        confirmLabel="Remove Comment"
        destructive
        loading={remove.isPending}
        onConfirm={async () => {
          await remove.run({ params, body: {} }, { ifMatch: c.rowVersion });
          setRemoveOpen(false);
          onChanged();
        }}
      />
      <ConflictDialog
        open={conflict}
        onOpenChange={setConflict}
        onReload={() => {
          setConflict(false);
          setEditing(false);
          onChanged();
        }}
      />
    </article>
  );
};

const ReplyComposer = ({
  versionId,
  replyToId,
  onDone,
}: {
  versionId: string;
  replyToId: string;
  onDone: () => void;
}) => {
  const { workspace } = useWorkspace();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useApiMutation(commentEndpoints.create, { invalidate: INVALIDATE, silentErrors: true });
  return (
    <div className="mt-2 flex flex-col gap-2">
      <Field label="Reply" hideLabel error={error}>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={LIMITS.commentMax}
          autoFocus
          placeholder="Write a reply"
          className="min-h-[64px]"
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!body.trim()}
          loading={create.isPending}
          onClick={async () => {
            setError(null);
            try {
              await create.run({
                params: { workspaceId: workspace.id },
                body: { parentType: 'content_version', parentId: versionId, body: body.trim(), replyToId },
              });
              onDone();
            } catch (e) {
              setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The reply was not saved.');
            }
          }}
        >
          Reply
        </Button>
      </div>
    </div>
  );
};

/**
 * Comments bound to one version (§10.3). Old versions keep their own comments and coordinates —
 * nothing moves to a new version (T046). Selecting an anchored comment highlights its marker.
 */
export const VersionComments = ({
  versionId,
  files,
  data,
  activeId,
  onSelect,
  showResolved,
  onShowResolvedChange,
  title = 'Comments',
}: {
  versionId: string;
  files: ContentVersionFile[];
  data: ReturnType<typeof useVersionComments>;
  activeId?: string | null;
  onSelect?: (thread: CommentThread) => void;
  showResolved: boolean;
  onShowResolvedChange: (v: boolean) => void;
  title?: string;
}) => {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  useEffect(() => {
    if (!activeId) return;
    const el = document.getElementById(`comment-${activeId}`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    el?.focus({ preventScroll: true });
  }, [activeId]);
  const q = data.q;
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[16px] font-semibold text-fg">
          {title}
          {q.data ? <span className="ml-2 text-[13px] font-normal text-fg-2">{q.data.total}</span> : null}
          {q.data?.openBlocking ? (
            <Badge tone="danger" className="ml-2">
              {q.data.openBlocking} open blocker{q.data.openBlocking === 1 ? '' : 's'}
            </Badge>
          ) : null}
        </h2>
        <Switch label="Show resolved" checked={showResolved} onCheckedChange={onShowResolvedChange} />
      </div>
      <QueryState query={q}>
        {data.numbered.filter(({ thread }) => showResolved || thread.state !== 'resolved').length === 0 ? (
          <EmptyState
            icon={<ChatCircle size={24} />}
            title="No comments on this version"
            description="Comments stay with the version they were written on."
            className="py-6"
          />
        ) : (
          <ol className="flex flex-col gap-2">
            {data.numbered
              .filter(({ thread }) => showResolved || thread.state !== 'resolved')
              .map(({ thread, index }) => (
                <li key={thread.id} className="rounded-[12px] border border-line bg-surface p-3">
                  <CommentBlock
                    c={thread}
                    index={index}
                    files={files}
                    active={activeId === thread.id}
                    onChanged={() => void q.refetch()}
                    onReply={() => setReplyTo(thread.id)}
                    onSelectAnchor={thread.assetVersionId && onSelect ? () => onSelect(thread) : undefined}
                  />
                  {thread.replies.length ? (
                    <div className="ml-9 mt-2 flex flex-col gap-2 border-l border-line pl-3">
                      {thread.replies.map((r) => (
                        <CommentBlock
                          key={r.id}
                          c={r}
                          files={files}
                          onChanged={() => void q.refetch()}
                          onReply={r.depth < 2 ? () => setReplyTo(r.id) : undefined}
                        />
                      ))}
                    </div>
                  ) : null}
                  {replyTo && [thread.id, ...thread.replies.map((r) => r.id)].includes(replyTo) ? (
                    <div className="ml-9">
                      <ReplyComposer
                        versionId={versionId}
                        replyToId={replyTo}
                        onDone={() => setReplyTo(null)}
                      />
                    </div>
                  ) : null}
                </li>
              ))}
          </ol>
        )}
      </QueryState>
    </section>
  );
};
