'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { knowledgeEndpoints, type ArticleDetail, type RichTextDocument } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { zonedDateTimeToUtc } from '@castlane/domain';
import { Badge, Banner, Button, DateTimeInput, Dialog, Field, Input, MultiSelect, RadioGroup, Select, Textarea, formatDateTime } from '@castlane/ui';
import { EntitySelect, MultiEntitySelect } from '@/components/common/entity-select';
import { MemberSelect, MultiMemberSelect } from '@/components/common/pickers';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';

/** datetime-local value in the member's zone → UTC ISO (the zone is always shown next to the input). */
export const localInputToIso = (value: string, zone: string): string | null => {
  if (!value) return null;
  const [date, time] = value.split('T');
  if (!date || !time) return null;
  return zonedDateTimeToUtc(date, time.slice(0, 5), zone).utc.toISOString();
};

/** Publish Version: freezes the draft; the revision kind decides whether required reading is asked again. */
export const PublishDialog = ({ open, onOpenChange, article, onPublished }: { open: boolean; onOpenChange: (o: boolean) => void; article: ArticleDetail; onPublished: () => void }) => {
  const { workspace } = useWorkspace();
  const first = !article.published;
  const [kind, setKind] = useState<'major' | 'minor'>('major');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setKind('major');
      setNote('');
      setError(null);
    }
  }, [open]);
  const publish = useApiMutation(knowledgeEndpoints.publish, { invalidate: ['knowledge.'], silentErrors: true, successMessage: 'Version published' });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={first ? 'Publish Article' : `Publish Version ${article.draft?.versionNo ?? ''}`}
      description="The published version is frozen. Later edits start a new draft."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)} disabled={publish.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={publish.isPending}
            disabled={!article.draft}
            onClick={async () => {
              if (!article.draft) return;
              setError(null);
              try {
                await publish.run({ params: { workspaceId: workspace.id, articleId: article.id }, body: { versionId: article.draft.id, revisionKind: kind, changeNote: note.trim() || undefined } }, { ifMatch: article.rowVersion });
                onOpenChange(false);
                onPublished();
              } catch (e) {
                setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The version could not be published.');
              }
            }}
          >
            Publish Version
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {!first ? (
          <RadioGroup
            label="Revision kind"
            value={kind}
            onValueChange={setKind}
            options={[
              {
                value: 'major',
                label: 'Major revision',
                description: article.requiredReading
                  ? 'Members who must read this article are asked to acknowledge the new version. Earlier acknowledgements stay in the history.'
                  : 'A substantive change of the rules.',
              },
              { value: 'minor', label: 'Minor revision', description: 'Typo or formatting fix. Earlier acknowledgements stay valid; nobody is asked to read again.' },
            ]}
          />
        ) : null}
        <Field label="Change note" helper="Shown in the version history.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </Field>
      </div>
    </Dialog>
  );
};

/** Assign Reading: members, role holders or project teams; only members who can read the article are asked. */
export const AssignReadingDialog = ({ open, onOpenChange, article }: { open: boolean; onOpenChange: (o: boolean) => void; article: ArticleDetail }) => {
  const { workspace, user } = useWorkspace();
  const [members, setMembers] = useState<string[]>([]);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [due, setDue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; alreadyAssigned: number; skippedNoAccess: number; skippedInactive: number } | null>(null);
  useEffect(() => {
    if (open) {
      setMembers([]);
      setRoleIds([]);
      setProjectIds([]);
      setDue('');
      setError(null);
      setResult(null);
    }
  }, [open]);
  const audiences = useApiQuery(knowledgeEndpoints.audiences, { params: { workspaceId: workspace.id } }, { enabled: open, staleTime: 60_000 });
  const assign = useApiMutation(knowledgeEndpoints.assignReading, { invalidate: ['knowledge.'], silentErrors: true });
  const empty = members.length + roleIds.length + projectIds.length === 0;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      dirty={!empty && !result && !assign.isPending}
      title="Assign Reading"
      description={`Version ${article.publishedVersionNo ?? ''} of “${article.title}”. Opening the article does not count as read — members confirm with Acknowledge Read.`}
      footer={
        result ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)} disabled={assign.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={assign.isPending}
              disabled={empty || !article.published}
              onClick={async () => {
                if (!article.published) return;
                setError(null);
                try {
                  const r = await assign.run({
                    params: { workspaceId: workspace.id, articleId: article.id },
                    body: { versionId: article.published.id, membershipIds: members, roleIds, projectIds, dueAt: localInputToIso(due, user.timezone) },
                  });
                  setResult(r);
                } catch (e) {
                  setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'Reading could not be assigned.');
                }
              }}
            >
              Assign Reading
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-2 text-[14px]">
          <Banner tone="success">
            {result.created} new reading request{result.created === 1 ? '' : 's'} sent.
          </Banner>
          <ul className="flex flex-col gap-1 text-fg-2">
            {result.alreadyAssigned ? <li>{result.alreadyAssigned} already asked or already acknowledged this version.</li> : null}
            {result.skippedNoAccess ? <li>{result.skippedNoAccess} cannot read this article (outside its scope) and were not asked.</li> : null}
            {result.skippedInactive ? <li>{result.skippedInactive} are not active members and were not asked.</li> : null}
          </ul>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Members">
            <MultiMemberSelect value={members} onChange={setMembers} placeholder="Choose members" />
          </Field>
          <Field label="Roles" helper="Everyone currently holding the role.">
            <MultiSelect
              value={roleIds}
              onChange={setRoleIds}
              placeholder={audiences.isLoading ? 'Loading…' : 'Choose roles'}
              options={(audiences.data?.roles ?? []).map((r) => ({ value: r.id, label: r.name, description: `${r.memberCount} active member${r.memberCount === 1 ? '' : 's'}` }))}
            />
          </Field>
          <Field label="Project teams" helper="Everyone currently on the project team.">
            <MultiEntitySelect type="project" value={projectIds} onChange={setProjectIds} placeholder="Choose projects" />
          </Field>
          <Field label="Acknowledge by">
            <DateTimeInput timezone={user.timezone} value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
        </div>
      )}
    </Dialog>
  );
};

/** Create Task from Checklist: a project task whose checklist is copied from the published version. */
export const CreateTaskDialog = ({
  open,
  onOpenChange,
  article,
  blockIndex,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  article: ArticleDetail;
  blockIndex: number | null;
}) => {
  const { workspace, user } = useWorkspace();
  const wsPath = useWsPath();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [due, setDue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ taskId: string; checklistItems: number } | null>(null);
  const items = useMemo(() => {
    const b = blockIndex !== null ? (article.published?.body as RichTextDocument | undefined)?.content[blockIndex] : undefined;
    return b?.type === 'checklist' ? b.items.map((it) => it.content.map((r) => r.text).join('')) : [];
  }, [article, blockIndex]);
  useEffect(() => {
    if (open) {
      setProjectId(article.scope.type === 'project' ? article.scope.id : null);
      setTitle(article.title.length >= 3 ? article.title.slice(0, 200) : `Checklist: ${article.title}`);
      setAssignee(null);
      setDue('');
      setError(null);
      setCreated(null);
    }
  }, [open, article]);
  const create = useApiMutation(knowledgeEndpoints.createTask, { silentErrors: true, invalidate: ['tasks.', 'myWork.'] });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create Task from Checklist"
      description={`${items.length} checklist item${items.length === 1 ? '' : 's'} from version ${article.publishedVersionNo ?? ''}.`}
      footer={
        created ? (
          <>
            <Button onClick={() => onOpenChange(false)}>Close</Button>
            <Link href={wsPath(`/tasks/${created.taskId}`)} className="inline-flex h-9 items-center rounded-[8px] bg-primary px-3 text-[13px] font-semibold text-on-primary hover:bg-primary-hover">
              Open Task
            </Link>
          </>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!projectId || title.trim().length < 3 || blockIndex === null || !article.published}
              onClick={async () => {
                if (!projectId || blockIndex === null || !article.published) return;
                setError(null);
                try {
                  const r = await create.run({
                    params: { workspaceId: workspace.id, articleId: article.id },
                    body: { versionId: article.published.id, blockIndex, projectId, title: title.trim(), assigneeMembershipId: assignee, dueAt: localInputToIso(due, user.timezone) },
                  });
                  setCreated(r);
                } catch (e) {
                  setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The task could not be created.');
                }
              }}
            >
              Create Task
            </Button>
          </>
        )
      }
    >
      {created ? (
        <Banner tone="success">The task was created with {created.checklistItems} checklist items.</Banner>
      ) : (
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <ul className="flex max-h-[160px] flex-col gap-1 overflow-y-auto rounded-[8px] bg-surface-2 p-3 text-[13px] text-fg">
            {items.map((t, i) => (
              <li key={i}>☐ {t}</li>
            ))}
          </ul>
          <Field label="Project" required>
            <EntitySelect type="project" value={projectId} onChange={(v) => setProjectId(v)} />
          </Field>
          <Field label="Task title" required>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Assignee">
            <MemberSelect value={assignee} onChange={setAssignee} projectId={projectId ?? undefined} permission="tasks.read" clearable />
          </Field>
          <Field label="Due">
            <DateTimeInput timezone={user.timezone} value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
        </div>
      )}
    </Dialog>
  );
};

/** Compare two versions: block-level diff summary. */
export const CompareDialog = ({ open, onOpenChange, article, versions, initial }: { open: boolean; onOpenChange: (o: boolean) => void; article: ArticleDetail; versions: { id: string; versionNo: number; state: string }[]; initial?: { from: string; to: string } }) => {
  const { workspace } = useWorkspace();
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setFrom(initial?.from ?? versions[1]?.id ?? null);
    setTo(initial?.to ?? versions[0]?.id ?? null);
  }, [open, initial, versions]);
  const cmp = useApiQuery(knowledgeEndpoints.compare, { params: { workspaceId: workspace.id, articleId: article.id }, query: { from: from ?? '', to: to ?? '' } }, { enabled: open && !!from && !!to && from !== to });
  const opts = versions.map((v) => ({ value: v.id, label: `Version ${v.versionNo}${v.state === 'draft' ? ' (draft)' : ''}` }));
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="wide" title="Compare Versions" footer={<Button onClick={() => onOpenChange(false)}>Close</Button>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="From">
            <Select value={from} onChange={setFrom} options={opts} />
          </Field>
          <Field label="To">
            <Select value={to} onChange={setTo} options={opts} />
          </Field>
        </div>
        {from === to ? <p className="text-[13px] text-fg-2">Choose two different versions.</p> : null}
        {cmp.isLoading ? <p className="text-[13px] text-fg-2">Comparing…</p> : null}
        {cmp.error ? <Banner tone="danger">{cmp.error.message}</Banner> : null}
        {cmp.data ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge tone="success">Added: {cmp.data.summary.added}</Badge>
              <Badge tone="danger">Removed: {cmp.data.summary.removed}</Badge>
              <Badge tone="info">Changed: {cmp.data.summary.changed}</Badge>
              <Badge>
                Words: {cmp.data.summary.wordsBefore} → {cmp.data.summary.wordsAfter}
              </Badge>
              {cmp.data.titleChanged ? <Badge tone="warning">Title changed</Badge> : null}
            </div>
            {cmp.data.changes.length === 0 ? <p className="text-[14px] text-fg-2">The text of these versions is identical.</p> : null}
            <ol className="flex flex-col gap-2">
              {cmp.data.changes.map((c, i) => (
                <li key={i} className="rounded-[8px] border border-line p-3 text-[13px]">
                  <p className="mb-1 font-[550] text-fg-2">
                    {c.kind === 'added' ? 'Added' : c.kind === 'removed' ? 'Removed' : 'Changed'} · {label('richBlock', c.blockType)}
                  </p>
                  {c.before !== null ? <p className="whitespace-pre-wrap rounded-[6px] bg-danger-soft px-2 py-1 text-fg">{c.before || '(empty)'}</p> : null}
                  {c.after !== null ? <p className="mt-1 whitespace-pre-wrap rounded-[6px] bg-selection px-2 py-1 text-fg">{c.after || '(empty)'}</p> : null}
                </li>
              ))}
            </ol>
            {cmp.data.truncated ? <p className="text-[12px] text-fg-2">Only the first 200 changes are shown.</p> : null}
            <p className="text-[12px] text-fg-muted">
              Version {cmp.data.from.versionNo}
              {cmp.data.from.publishedAt ? ` (${formatDateTime(cmp.data.from.publishedAt)})` : ''} → version {cmp.data.to.versionNo}
              {cmp.data.to.publishedAt ? ` (${formatDateTime(cmp.data.to.publishedAt)})` : ''}
            </p>
          </>
        ) : null}
      </div>
    </Dialog>
  );
};
