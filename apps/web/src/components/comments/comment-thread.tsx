'use client';
import { ArrowBendUpLeft, ChatCircle, CheckCircle, ClockCounterClockwise, PencilSimple, Trash } from '@phosphor-icons/react';
import { useState } from 'react';
import { commentEndpoints, peopleEndpoints, type CommentThread as Thread, type CommentView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { LIMITS } from '@castlane/domain';
import { Avatar, Badge, Button, ConfirmDialog, Dialog, EmptyState, Field, MultiSelect, Switch, Textarea, cn, formatDateTime, formatRelative, toast } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { ConflictDialog } from '@/components/common/conflict';
import { useEditBase } from '@/lib/edit-base';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';

const INVALIDATE = ['comments.'];

/** Mention picker: only people who can read the record are offered (the server checks again). */
const MentionPicker = ({ projectId, permission, value, onChange }: { projectId: string | null; permission: string | null; value: string[]; onChange: (v: string[]) => void }) => {
  const { workspace, membershipId } = useWorkspace();
  const q = useApiQuery(
    peopleEndpoints.lookup,
    { params: { workspaceId: workspace.id }, query: { projectId: projectId ?? undefined, permission: projectId ? (permission ?? undefined) : undefined, limit: 100 } },
    { staleTime: 60_000 },
  );
  return (
    <MultiSelect
      aria-label="Mention people"
      placeholder={q.isLoading ? 'Loading…' : 'Mention people (optional)'}
      value={value}
      onChange={onChange}
      max={30}
      options={(q.data ?? []).filter((p) => p.membershipId !== membershipId).map((p) => ({ value: p.membershipId, label: p.displayName, description: p.title ?? undefined }))}
    />
  );
};

const Composer = ({
  parentType,
  parentId,
  replyToId,
  projectId,
  mentionPermission,
  onDone,
  autoFocus,
}: {
  parentType: string;
  parentId: string;
  replyToId?: string;
  projectId: string | null;
  mentionPermission: string | null;
  onDone?: () => void;
  autoFocus?: boolean;
}) => {
  const { workspace } = useWorkspace();
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const create = useApiMutation(commentEndpoints.create, { invalidate: INVALIDATE, silentErrors: true });
  const submit = async () => {
    setError(null);
    try {
      await create.run({ params: { workspaceId: workspace.id }, body: { parentType, parentId, body: body.trim(), replyToId, mentions: mentions.length ? mentions : undefined } });
      setBody('');
      setMentions([]);
      onDone?.();
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The comment was not saved.');
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <Field label={replyToId ? 'Reply' : 'Comment'} hideLabel error={error}>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={LIMITS.commentMax}
          placeholder={replyToId ? 'Write a reply' : 'Write a comment — decisions, questions and hand-offs stay with this record'}
          autoFocus={autoFocus}
          className="min-h-[72px]"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) void submit();
          }}
        />
      </Field>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <MentionPicker projectId={projectId} permission={mentionPermission} value={mentions} onChange={setMentions} />
        </div>
        <div className="flex justify-end gap-2">
          {onDone && replyToId ? (
            <Button size="sm" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          ) : null}
          <Button size="sm" variant="primary" disabled={!body.trim()} loading={create.isPending} onClick={() => void submit()}>
            {replyToId ? 'Reply' : 'Add Comment'}
          </Button>
        </div>
      </div>
    </div>
  );
};

const CommentItem = ({
  c,
  onReply,
  onChanged,
}: {
  c: CommentView;
  onReply?: () => void;
  onChanged: () => void;
}) => {
  const { workspace, user } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.body ?? '');
  // Editing works against the comment as it was when Edit was pressed (T162).
  const edit = useEditBase(c, { open: editing, onReload: (latest) => setText(latest.body ?? '') });
  const [removeOpen, setRemoveOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reason, setReason] = useState('');
  const reopenBase = useEditBase(c, { open: reopenOpen, onReload: () => setReason('') });
  const [historyOpen, setHistoryOpen] = useState(false);
  const params = { workspaceId: workspace.id, commentId: c.id };
  const update = useApiMutation(commentEndpoints.update, { invalidate: INVALIDATE, successMessage: 'Comment updated', silentErrors: true });
  const resolve = useApiMutation(commentEndpoints.resolve, { invalidate: INVALIDATE, successMessage: 'Thread resolved' });
  const reopen = useApiMutation(commentEndpoints.reopen, { invalidate: INVALIDATE, successMessage: 'Thread reopened' });
  const remove = useApiMutation(commentEndpoints.remove, { invalidate: INVALIDATE, successMessage: 'Comment removed' });
  const history = useApiQuery(commentEndpoints.revisions, { params }, { enabled: historyOpen });
  return (
    <article className={cn('flex gap-3', c.depth > 0 && 'mt-3')} aria-label={`Comment by ${c.author.displayName}`}>
      <Avatar name={c.author.displayName} src={c.author.avatarUrl} size={28} decorative />
      <div className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] leading-[18px] text-fg-2">
          <span className="font-semibold text-fg">{c.author.displayName}</span>
          <time dateTime={c.createdAt} title={formatDateTime(c.createdAt, user.timezone)}>
            {formatRelative(c.createdAt)}
          </time>
          {c.editedAt ? (
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => setHistoryOpen(true)}>
              Edited
            </button>
          ) : null}
          {c.severity === 'blocking' ? <Badge tone="danger">Blocking</Badge> : null}
          {c.state === 'resolved' ? <Badge tone="success" icon={<CheckCircle size={12} aria-hidden />}>Resolved</Badge> : null}
          {c.state === 'reopened' ? <Badge tone="warning">Reopened</Badge> : null}
        </header>
        {editing ? (
          <div className="mt-2 flex flex-col gap-2">
            <Field label="Edit comment" hideLabel>
              <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={LIMITS.commentMax} autoFocus />
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
                    await update.run({ params, body: { body: text.trim() } }, { ifMatch: edit.version });
                    setEditing(false);
                    onChanged();
                  } catch (e) {
                    if (!edit.catchConflict(e)) toast.error(isApiError(e) ? e.message : 'The comment was not saved.');
                  }
                }}
              >
                Save
              </Button>
            </div>
          </div>
        ) : c.removed ? (
          <p className="mt-1 text-[14px] italic leading-[22px] text-fg-muted">This comment was removed.</p>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-[22px] text-fg">{c.body}</p>
        )}
        {c.mentions.length && !c.removed ? <p className="mt-1 text-[12px] text-fg-2">Mentioned: {c.mentions.map((m) => m.displayName).join(', ')}</p> : null}
        {c.resolutionNote && c.state === 'resolved' ? <p className="mt-1 text-[12px] text-fg-2">Resolution: {c.resolutionNote}</p> : null}
        {!editing ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {c.permissions.reply && onReply ? (
              <Button size="sm" variant="ghost" icon={<ArrowBendUpLeft size={14} />} onClick={onReply}>
                Reply
              </Button>
            ) : null}
            {c.permissions.edit ? (
              <Button size="sm" variant="ghost" icon={<PencilSimple size={14} />} onClick={() => { setText(c.body ?? ''); setEditing(true); }}>
                Edit
              </Button>
            ) : null}
            {c.permissions.resolve ? (
              <Button size="sm" variant="ghost" icon={<CheckCircle size={14} />} loading={resolve.isPending} onClick={() => void resolve.run({ params, body: {} }, { ifMatch: c.rowVersion }).then(onChanged)}>
                Resolve
              </Button>
            ) : null}
            {c.permissions.reopen ? (
              <Button size="sm" variant="ghost" icon={<ClockCounterClockwise size={14} />} onClick={() => setReopenOpen(true)}>
                Reopen
              </Button>
            ) : null}
            {c.permissions.remove ? (
              <Button size="sm" variant="ghost" icon={<Trash size={14} />} onClick={() => setRemoveOpen(true)}>
                Remove Comment
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title="Remove this comment?"
        body="The text is hidden for everyone. The fact that a comment existed and its history stay in the record."
        confirmLabel="Remove Comment"
        destructive
        loading={remove.isPending}
        onConfirm={async () => {
          await remove.run({ params, body: {} }, { ifMatch: c.rowVersion });
          setRemoveOpen(false);
          onChanged();
        }}
      />
      <ConfirmDialog
        open={reopenOpen}
        onOpenChange={(o) => {
          setReopenOpen(o);
          if (!o) setReason('');
        }}
        title="Reopen this thread?"
        body="The thread becomes open again. Explain what still needs attention."
        confirmLabel="Reopen"
        loading={reopen.isPending}
        confirmDisabled={reason.trim().length < 3}
        onConfirm={async () => {
          try {
            await reopen.run({ params, body: { reason: reason.trim() } }, { ifMatch: reopenBase.version });
            setReopenOpen(false);
            setReason('');
            onChanged();
          } catch (e) {
            reopenBase.catchConflict(e);
          }
        }}
      >
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={LIMITS.reasonMax} />
        </Field>
      </ConfirmDialog>
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen} title="Edit history" size="regular" description="Earlier texts of this comment, oldest first.">
        <QueryState query={history}>
          <ol className="flex flex-col gap-3">
            {(history.data ?? []).map((r) => (
              <li key={r.id} className="rounded-[8px] border border-line p-3">
                <p className="text-[12px] text-fg-2">Replaced {formatDateTime(r.replacedAt, user.timezone)}</p>
                <p className="mt-1 whitespace-pre-wrap text-[14px] text-fg">{r.previousBody}</p>
              </li>
            ))}
          </ol>
        </QueryState>
      </Dialog>
      <ConflictDialog {...edit.conflictDialog} />
      <ConflictDialog {...reopenBase.conflictDialog} />
    </article>
  );
};

const ThreadView = ({ t, projectId, mentionPermission, refetch }: { t: Thread; projectId: string | null; mentionPermission: string | null; refetch: () => void }) => {
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const nodes = [t, ...t.replies];
  return (
    <li className="rounded-[12px] border border-line bg-surface p-4">
      <CommentItem c={t} onReply={() => setReplyTo(t.id)} onChanged={refetch} />
      {t.replies.length ? (
        <div className="ml-10 border-l border-line pl-3">
          {t.replies.map((r) => (
            <CommentItem key={r.id} c={r} onReply={() => setReplyTo(r.id)} onChanged={refetch} />
          ))}
        </div>
      ) : null}
      {replyTo && nodes.some((n) => n.id === replyTo) ? (
        <div className="ml-10 mt-3">
          <Composer parentType={t.parentType} parentId={t.parentId} replyToId={replyTo} projectId={projectId} mentionPermission={mentionPermission} onDone={() => setReplyTo(null)} autoFocus />
        </div>
      ) : null}
    </li>
  );
};

/**
 * Threaded comments on any record type registered with `defineCommentParent` (tasks here; content,
 * reviews and articles in their modules). Replies nest at most two levels; edits keep history.
 */
export const CommentThread = ({ parentType, parentId, title = 'Comments' }: { parentType: string; parentId: string; title?: string }) => {
  const { workspace } = useWorkspace();
  const [showResolved, setShowResolved] = useState(true);
  const q = useApiQuery(commentEndpoints.list, { params: { workspaceId: workspace.id }, query: { parentType, parentId, includeResolved: showResolved } });
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[16px] font-semibold leading-6 text-fg">
          {title}
          {q.data ? <span className="ml-2 text-[13px] font-normal text-fg-2">{q.data.total}</span> : null}
        </h2>
        <Switch label="Show resolved" checked={showResolved} onCheckedChange={setShowResolved} />
      </div>
      <QueryState query={q}>
        {q.data ? (
          <>
            {q.data.threads.length === 0 ? (
              <EmptyState icon={<ChatCircle size={24} />} title="No comments yet" description={q.data.canComment ? 'Ask a question or record a decision here. Mention people to notify them.' : 'Comments from the team will appear here.'} className="py-6" />
            ) : (
              <ol className="flex flex-col gap-3">
                {q.data.threads.map((t) => (
                  <ThreadView key={t.id} t={t} projectId={q.data!.projectId} mentionPermission={q.data!.mentionPermission} refetch={() => void q.refetch()} />
                ))}
              </ol>
            )}
            {q.data.canComment ? <Composer parentType={parentType} parentId={parentId} projectId={q.data.projectId} mentionPermission={q.data.mentionPermission} /> : null}
          </>
        ) : null}
      </QueryState>
    </section>
  );
};
