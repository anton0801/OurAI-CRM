'use client';
import { PushPin, Plus } from '@phosphor-icons/react';
import { useState } from 'react';
import { projectEndpoints, type ProjectDetail } from '@castlane/api-contracts';
import { Button, DateInput, DescriptionList, Dialog, Field, Input, Panel, Textarea, formatDate } from '@castlane/ui';
import { CustomFieldsPanel } from '@/components/custom-fields/custom-fields-panel';
import { useApiMutation } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';

export const ProjectOverviewTab = ({ project }: { project: ProjectDetail }) => {
  const { workspace } = useWorkspace();
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [mTitle, setMTitle] = useState('');
  const [mDue, setMDue] = useState('');
  const [dTitle, setDTitle] = useState('');
  const [dBody, setDBody] = useState('');
  const addMilestone = useApiMutation(projectEndpoints.addMilestone, { invalidate: ['projects.get'], successMessage: 'Milestone added' });
  const pin = useApiMutation(projectEndpoints.pinDecision, { invalidate: ['projects.get'], successMessage: 'Decision pinned' });
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Panel title="Brief" className="lg:col-span-2">
        {project.briefSummary ? <p className="whitespace-pre-wrap text-[14px] leading-[22px] text-fg">{project.briefSummary}</p> : <p className="text-[14px] text-fg-2">No brief yet. Add one before activating the project.</p>}
        {project.description ? <p className="mt-3 whitespace-pre-wrap text-[14px] leading-[22px] text-fg-2">{project.description}</p> : null}
        <div className="mt-4">
          <DescriptionList
            columns={3}
            items={[
              { label: 'Type', value: label('projectType', project.type) },
              { label: 'Direction', value: project.direction.name },
              { label: 'Language', value: project.language },
              { label: 'Target Markets', value: project.targetMarkets.join(', ') || null },
              { label: 'Audience', value: project.audience },
              { label: 'Start Date', value: project.startDate ? formatDate(project.startDate) : null },
              { label: 'OFM', value: project.ofmEnabled ? 'Enabled' : 'Not enabled', hidden: project.type === 'series' },
              { label: 'Tags', value: project.tags.join(', ') || null },
            ]}
          />
        </div>
      </Panel>
      <Panel title="At a glance">
        <DescriptionList
          columns={1}
          items={[
            { label: 'Accounts', value: project.counts.accounts },
            { label: 'Content items', value: project.counts.content },
            { label: 'Open tasks', value: project.counts.openTasks },
            { label: 'Scheduled publications', value: project.counts.scheduledPublications },
            { label: 'Characters', value: project.counts.characters },
          ]}
        />
      </Panel>
      <Panel
        title="Milestones"
        className="lg:col-span-2"
        actions={
          project.permissions.update ? (
            <Button size="sm" icon={<Plus size={12} />} onClick={() => setMilestoneOpen(true)}>
              Add Milestone
            </Button>
          ) : undefined
        }
      >
        {project.milestones.length === 0 ? (
          <p className="text-[14px] text-fg-2">No milestones yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {project.milestones.map((m) => (
              <li key={m.id} className="flex items-center justify-between py-2 text-[14px]">
                <span className="text-fg">{m.title}</span>
                <span className="text-fg-2">{m.completedAt ? 'Completed' : m.dueDate ? `Due ${formatDate(m.dueDate)}` : 'No date'}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel
        title="Recent decisions"
        actions={
          project.permissions.update ? (
            <Button size="sm" icon={<PushPin size={12} />} onClick={() => setDecisionOpen(true)}>
              Pin Decision
            </Button>
          ) : undefined
        }
      >
        {project.decisions.length === 0 ? (
          <p className="text-[14px] text-fg-2">No decisions recorded.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {project.decisions.map((d) => (
              <li key={d.id}>
                <p className="text-[14px] font-semibold text-fg">{d.title}</p>
                <p className="whitespace-pre-wrap text-[13px] text-fg-2">{d.body}</p>
                <p className="text-[12px] text-fg-muted">
                  {formatDate(d.decidedAt)} · version {d.version}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <CustomFieldsPanel entityType="project" entityId={project.id} className="lg:col-span-3" />
      <Dialog
        open={milestoneOpen}
        onOpenChange={setMilestoneOpen}
        title="Add milestone"
        size="small"
        dirty={!!mTitle}
        footer={
          <>
            <Button onClick={() => setMilestoneOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={addMilestone.isPending}
              disabled={mTitle.trim().length < 2}
              onClick={async () => {
                await addMilestone.run({ params: { workspaceId: workspace.id, projectId: project.id }, body: { title: mTitle, dueDate: mDue || null } });
                setMTitle('');
                setMDue('');
                setMilestoneOpen(false);
              }}
            >
              Add Milestone
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Title" required>
            <Input value={mTitle} onChange={(e) => setMTitle(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Due date">
            <DateInput value={mDue} onChange={(e) => setMDue(e.target.value)} />
          </Field>
        </div>
      </Dialog>
      <Dialog
        open={decisionOpen}
        onOpenChange={setDecisionOpen}
        title="Pin a decision"
        description="The text is frozen as a version once pinned."
        dirty={!!dTitle || !!dBody}
        footer={
          <>
            <Button onClick={() => setDecisionOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={pin.isPending}
              disabled={dTitle.trim().length < 2 || dBody.trim().length < 3}
              onClick={async () => {
                await pin.run({ params: { workspaceId: workspace.id, projectId: project.id }, body: { title: dTitle, body: dBody } });
                setDTitle('');
                setDBody('');
                setDecisionOpen(false);
              }}
            >
              Pin Decision
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Title" required>
            <Input value={dTitle} onChange={(e) => setDTitle(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Decision" required>
            <Textarea value={dBody} onChange={(e) => setDBody(e.target.value)} maxLength={5000} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
};
