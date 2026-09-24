'use client';
import { useEffect, useMemo, useState } from 'react';
import { taskEndpoints } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Banner, Button, DateInput, Dialog, EmptyState, Field, Select, formatDate, formatDateTime, humanize } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { MemberSelect } from '@/components/common/pickers';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';
import { todayIn } from './format';
import { TASK_INVALIDATE } from './task-actions';

/**
 * Apply a published task template to a project: preview names, assignments and dates first; the
 * graph is created exactly once per application key. Unknown owners stay Unassigned and one
 * coordination task asks you to assign them. Templates are managed in Settings → Templates.
 */
export const ApplyTemplateDialog = ({ open, onOpenChange, projectId: fixedProject, onApplied }: { open: boolean; onOpenChange: (o: boolean) => void; projectId?: string; onApplied?: () => void }) => {
  const { workspace, user } = useWorkspace();
  const [versionId, setVersionId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(fixedProject ?? null);
  const [startDate, setStartDate] = useState(todayIn(user.timezone));
  const [assignees, setAssignees] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: boolean; count: number; coordination: boolean } | null>(null);
  const options = useApiQuery(taskEndpoints.templateOptions, { params: { workspaceId: workspace.id }, query: {} }, { enabled: open });
  const preview = useApiMutation(taskEndpoints.templatePreview, { silentErrors: true });
  const apply = useApiMutation(taskEndpoints.applyTemplate, { invalidate: TASK_INVALIDATE, silentErrors: true });
  useEffect(() => {
    if (open) {
      setProjectId(fixedProject ?? null);
      setDone(null);
      setError(null);
      setAssignees({});
      preview.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const target = versionId && projectId ? { templateVersionId: versionId, targetType: 'project' as const, targetId: projectId, projectId, startDate, timezone: user.timezone, assignees } : null;
  // Roles to assign: responsibilities (or task keys) found in the preview.
  const roles = useMemo(() => {
    const out = new Map<string, string>();
    for (const t of preview.data?.tasks ?? []) out.set(t.responsibility ?? t.key, t.responsibility ? humanize(t.responsibility) : t.title);
    return [...out.entries()];
  }, [preview.data]);
  const runPreview = async (next = assignees) => {
    if (!target) return;
    setError(null);
    try {
      await preview.run({ params: { workspaceId: workspace.id }, body: { ...target, assignees: next } });
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The preview failed.');
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="wide"
      title="Apply Template"
      description="Tasks are created only after you review names, assignments and dates."
      footer={
        done ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={!target} loading={preview.isPending} onClick={() => void runPreview()}>
              Preview
            </Button>
            <Button
              variant="primary"
              disabled={!preview.data || !target}
              loading={apply.isPending}
              onClick={async () => {
                setError(null);
                try {
                  const r = await apply.run({ params: { workspaceId: workspace.id }, body: { ...target!, applicationKey: preview.data!.applicationKey } });
                  setDone({ created: r.created, count: r.taskIds.length, coordination: !!r.coordinationTaskId });
                  onApplied?.();
                } catch (e) {
                  setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The template was not applied.');
                }
              }}
            >
              Create Tasks
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {done ? (
          <Banner tone="success">
            {done.created
              ? `${done.count} tasks created.${done.coordination ? ' A coordination task asks you to assign the remaining owners.' : ''}`
              : 'This template was already applied with the same start date. Nothing new was created.'}
          </Banner>
        ) : (
          <QueryState query={options}>
            {options.data && options.data.length === 0 ? (
              <EmptyState title="No published templates" description="Templates with tasks are created and published in Settings → Templates." className="py-6" />
            ) : (
              <>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <Field label="Template" required>
                    <Select
                      value={versionId}
                      onChange={(v) => { setVersionId(v); preview.reset(); }}
                      options={(options.data ?? []).map((o) => ({ value: o.templateVersionId, label: `${o.name} · v${o.versionNo}`, description: `${o.taskCount} tasks${o.description ? ` · ${o.description}` : ''}` }))}
                    />
                  </Field>
                  <Field label="Project" required>
                    <EntitySelect type="project" value={projectId} onChange={(v) => { setProjectId(v); preview.reset(); }} disabled={!!fixedProject} />
                  </Field>
                  <Field label="Start date" required helper="Offsets count from this date.">
                    <DateInput value={startDate} onChange={(e) => { setStartDate(e.target.value); preview.reset(); }} />
                  </Field>
                </div>
                {preview.data ? (
                  <>
                    {preview.data.existingApplication ? (
                      <Banner tone="info">
                        Already applied on {formatDateTime(preview.data.existingApplication.appliedAt, user.timezone)} ({preview.data.existingApplication.taskCount} tasks). Applying again creates nothing new.
                      </Banner>
                    ) : null}
                    {roles.length ? (
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                        {roles.map(([key, name]) => (
                          <Field key={key} label={name}>
                            <MemberSelect
                              value={assignees[key] ?? null}
                              onChange={(v) => {
                                const next = { ...assignees };
                                if (v) next[key] = v;
                                else delete next[key];
                                setAssignees(next);
                                void runPreview(next);
                              }}
                              projectId={projectId ?? undefined}
                              permission="tasks.read"
                              clearable
                              placeholder="Unassigned"
                            />
                          </Field>
                        ))}
                      </div>
                    ) : null}
                    <div className="overflow-x-auto rounded-[12px] border border-line">
                      <table className="w-full min-w-[640px] text-left text-[13px]">
                        <caption className="sr-only">Tasks the template will create</caption>
                        <thead>
                          <tr className="h-10 border-b border-line text-[12px] text-fg-2">
                            <th className="px-3">Task</th>
                            <th className="px-3">Assignee</th>
                            <th className="px-3">Start</th>
                            <th className="px-3">Due</th>
                            <th className="px-3">Waits for</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.data.tasks.map((t) => (
                            <tr key={t.key} className="h-11 border-b border-line last:border-0">
                              <td className="px-3 text-fg">{t.title}{t.checklistCount ? <span className="text-fg-2"> · {t.checklistCount} checklist items</span> : null}</td>
                              <td className="px-3">{t.assignee?.displayName ?? <span className="text-fg-muted">Unassigned</span>}</td>
                              <td className="px-3">{formatDate(t.startDate)}</td>
                              <td className="px-3">{formatDate(t.dueDate)}</td>
                              <td className="px-3 text-fg-2">{t.dependsOn.join(', ') || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {preview.data.unassignedCount ? <p className="text-[13px] text-fg-2">{preview.data.unassignedCount} task(s) stay Unassigned; nobody is chosen for you.</p> : null}
                  </>
                ) : null}
              </>
            )}
          </QueryState>
        )}
      </div>
    </Dialog>
  );
};
