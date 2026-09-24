'use client';
import { useState } from 'react';
import { reportEndpoints as R, type ReportDetail, type ReportScheduleRow } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { REPORT_CADENCES } from '@castlane/domain';
import { Badge, Banner, Button, Checkbox, Dialog, Field, Input, Panel, RadioGroup, Select, formatDateTime } from '@castlane/ui';
import { MultiMemberSelect } from '@/components/common/pickers';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { errorMessage, useInsightsMutation } from '../metrics/common';

/** Share Internally: recipients see the report and run it in their own scope — no data access is granted. */
export const ShareDialog = ({ report, onClose, onConflict }: { report: ReportDetail; onClose: () => void; onConflict: () => void }) => {
  const { workspace } = useWorkspace();
  const [sharing, setSharing] = useState<'private' | 'shared'>(report.sharing);
  const [members, setMembers] = useState<string[]>(report.sharedWith.map((m) => m.membershipId));
  const [error, setError] = useState<string | null>(null);
  const share = useInsightsMutation(R.share, { successMessage: 'Sharing updated' });
  const submit = async () => {
    setError(null);
    try {
      await share.run({ params: { workspaceId: workspace.id, reportId: report.id }, body: { sharing, memberIds: sharing === 'shared' ? members : [] } }, { ifMatch: report.rowVersion });
      onClose();
    } catch (e) {
      if (isApiError(e) && e.code === 'VERSION_CONFLICT') {
        onClose();
        onConflict();
      } else setError(isApiError(e) && e.fieldErrors.length ? e.fieldErrors[0]!.message : errorMessage(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title="Share Report"
      description="Members you share with can open and run this report. Each of them sees only the data they already have access to."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={share.isPending} onClick={() => void submit()}>
            Save Sharing
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <RadioGroup
          label="Sharing"
          value={sharing}
          onValueChange={setSharing}
          options={[
            { value: 'private', label: 'Private', description: 'Only you can open the report.' },
            { value: 'shared', label: 'Shared with members', description: 'Chosen members can open and run it with their own access.' },
          ]}
        />
        {sharing === 'shared' ? (
          <Field label="Members" required>
            <MultiMemberSelect value={members} onChange={setMembers} placeholder="Choose members" />
          </Field>
        ) : null}
        {error ? <Banner tone="danger">{error}</Banner> : null}
      </div>
    </Dialog>
  );
};

/** Schedule: daily / weekly / monthly delivery; each recipient receives a snapshot computed with their own access. */
export const ScheduleDialog = ({ report, onClose }: { report: ReportDetail; onClose: () => void }) => {
  const { workspace, user, membershipId } = useWorkspace();
  const [cadence, setCadence] = useState<(typeof REPORT_CADENCES)[number]>('weekly');
  const [recipients, setRecipients] = useState<string[]>([membershipId]);
  const [time, setTime] = useState('08:00');
  const [timezone, setTimezone] = useState(user.timezone);
  const [email, setEmail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useInsightsMutation(R.scheduleCreate, { successMessage: 'Schedule created' });
  const submit = async () => {
    setError(null);
    try {
      await create.run({ params: { workspaceId: workspace.id }, body: { reportId: report.id, cadence, recipientMembershipIds: recipients, localTime: time, timezone, emailNotify: email } });
      onClose();
    } catch (e) {
      setError(isApiError(e) && e.fieldErrors.length ? e.fieldErrors[0]!.message : errorMessage(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title="Schedule Report"
      description="Each recipient receives the result of their own permitted data in their Inbox. Recipients who lose report access are skipped."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} onClick={() => void submit()}>
            Create Schedule
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Cadence" required>
          <Select value={cadence} onChange={(v) => v && setCadence(v)} options={REPORT_CADENCES.map((c) => ({ value: c, label: label('reportCadence', c) }))} />
        </Field>
        <Field label="Time" required helper="HH:MM in the schedule time zone.">
          <Input value={time} onChange={(e) => setTime(e.target.value)} placeholder="08:00" maxLength={5} />
        </Field>
        <Field label="Time zone" required className="sm:col-span-2">
          <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </Field>
        <Field label="Recipients" required className="sm:col-span-2">
          <MultiMemberSelect value={recipients} onChange={setRecipients} placeholder="Choose members" />
        </Field>
        <div className="sm:col-span-2">
          <Checkbox checked={email} onCheckedChange={setEmail} label="Also send a short e-mail notice" description="The e-mail only says that a report is ready; it never contains report data." />
        </div>
        {error ? (
          <Banner tone="danger" className="sm:col-span-2">
            {error}
          </Banner>
        ) : null}
      </div>
    </Dialog>
  );
};

/** Schedules of a report with their status, next run and last result; the owner can pause or resume. */
export const SchedulesList = ({ report }: { report: ReportDetail }) => {
  const { workspace, user } = useWorkspace();
  const pause = useInsightsMutation(R.schedulePause, { successMessage: 'Schedule paused' });
  const resume = useInsightsMutation(R.scheduleResume, { successMessage: 'Schedule resumed' });
  const [error, setError] = useState<string | null>(null);
  if (!report.schedules.length) return null;
  const act = async (s: ReportScheduleRow) => {
    setError(null);
    try {
      if (s.status === 'active') await pause.run({ params: { workspaceId: workspace.id, scheduleId: s.id } }, { ifMatch: s.rowVersion });
      else await resume.run({ params: { workspaceId: workspace.id, scheduleId: s.id } }, { ifMatch: s.rowVersion });
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Panel title="Schedules">
      <ul className="flex flex-col divide-y divide-line text-[13px]">
        {report.schedules.map((s) => (
          <li key={s.id} className="flex flex-col gap-1 py-2 md:flex-row md:items-center md:justify-between">
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-fg">
                  {label('reportCadence', s.cadence)} at {s.localTime} ({s.timezone})
                </span>
                <Badge tone={s.status === 'active' ? 'success' : 'warning'}>{label('scheduleStatus', s.status)}</Badge>
              </span>
              <span className="block text-fg-2">
                {s.recipients.length} recipient(s) · owner {s.owner.displayName}
                {s.status === 'active' ? ` · next ${formatDateTime(s.nextRunAt, user.timezone)}` : s.pausedReason ? ` · ${s.pausedReason}` : ''}
                {s.lastRunResult ? ` · last run delivered ${s.lastRunResult.delivered}${s.lastRunResult.skipped.length ? `, skipped ${s.lastRunResult.skipped.length}` : ''}` : ''}
              </span>
            </span>
            {s.permissions.edit ? (
              <Button size="sm" loading={pause.isPending || resume.isPending} onClick={() => void act(s)}>
                {s.status === 'active' ? 'Pause' : s.status === 'paused_needs_owner' ? 'Take Over and Resume' : 'Resume'}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? <p className="mt-2 text-[13px] text-danger">{error}</p> : null}
    </Panel>
  );
};
