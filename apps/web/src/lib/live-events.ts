'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/**
 * Entity type → query-key prefixes (endpoint id prefixes) to refresh when the entity changes.
 * Events carry only type/id/revision; data is always re-read through the normal authorised APIs.
 */
const PREFIXES: Record<string, string[]> = {
  project: ['projects.', 'overview.', 'directions.'],
  direction: ['directions.', 'projects.'],
  character: ['characters.', 'projects.'],
  season: ['series.'],
  episode: ['series.'],
  scene: ['series.'],
  account: ['accounts.', 'overview.'],
  reference: ['references.'],
  content_item: ['content.', 'reviews.', 'overview.', 'myWork.'],
  content_version: ['content.', 'reviews.'],
  review: ['reviews.', 'content.', 'overview.', 'myWork.'],
  comment: ['comments.', 'reviews.'],
  task: ['tasks.', 'myWork.', 'overview.', 'workload.', 'calendar.'],
  time_entry: ['time.', 'myWork.'],
  publication: ['publications.', 'calendar.', 'overview.', 'myWork.', 'metrics.'],
  campaign: ['campaigns.'],
  experiment: ['experiments.'],
  asset: ['assets.', 'library.'],
  upload: ['assets.', 'library.'],
  article: ['knowledge.'],
  shift: ['ofm.', 'myWork.', 'calendar.'],
  handover: ['ofm.'],
  ofm_contact: ['ofm.'],
  operation: ['ofm.'],
  sale_candidate: ['ofm.', 'finance.'],
  quality_review: ['ofm.'],
  metric_observation: ['metrics.', 'analytics.', 'overview.'],
  metric_checkpoint: ['metrics.', 'myWork.'],
  goal: ['goals.'],
  saved_report: ['reports.'],
  financial_entry: ['finance.'],
  settlement: ['finance.'],
  budget: ['finance.'],
  compensation_run: ['finance.'],
  partner: ['partners.'],
  deal: ['deals.', 'partners.'],
  membership: ['team.', 'members.'],
  invitation: ['team.'],
  automation_rule: ['automations.'],
  import_job: ['imports.'],
  export_job: ['exports.'],
  incident: ['incidents.', 'health.'],
  notification: ['notifications.', 'inbox.'],
  folder: ['folders.', 'assets.'],
  article_category: ['knowledge.'],
  time_sheet: ['time.', 'myWork.'],
  absence: ['workload.', 'myWork.'],
  capacity: ['workload.'],
  recurrence_rule: ['recurrences.', 'tasks.'],
  personal_reminder: ['reminders.', 'myWork.', 'tasks.'],
  template: ['templates.'],
  custom_field_definition: ['customFields.'],
  custom_field_values: ['customFields.'],
  saved_view: ['savedViews.'],
};

export const useLiveEvents = (workspaceId: string) => {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let pending = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const flush = () => {
      flushTimer = null;
      const prefixes = pending;
      pending = new Set();
      void qc.invalidateQueries({
        predicate: (q) => {
          const k = String(q.queryKey[0] ?? '');
          for (const p of prefixes) if (k.startsWith(p)) return true;
          return false;
        },
      });
    };
    const schedule = (prefixes: string[]) => {
      prefixes.forEach((p) => pending.add(p));
      flushTimer ??= setTimeout(flush, 800);
    };
    const startPolling = () => {
      pollTimer ??= setInterval(() => void qc.invalidateQueries({ refetchType: 'active' }), 30_000);
    };
    const connect = () => {
      es = new EventSource(`/api/v1/workspaces/${workspaceId}/events`);
      es.addEventListener('open', () => {
        failures = 0;
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      });
      es.addEventListener('entity_changed', (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data) as { t: string | null };
          schedule(PREFIXES[d.t ?? ''] ?? []);
        } catch {
          /* ignore malformed event */
        }
      });
      es.addEventListener('inbox', () => schedule(['notifications.', 'inbox.']));
      es.addEventListener('job_progress', () => schedule(['imports.', 'exports.', 'jobs.']));
      es.addEventListener('resync', () => void qc.invalidateQueries());
      es.addEventListener('access_changed', () => {
        es?.close();
        // Permissions changed: reload so the server re-evaluates navigation and data scope.
        window.location.reload();
      });
      es.addEventListener('error', () => {
        failures++;
        if (failures >= 3) {
          es?.close();
          startPolling();
          setTimeout(connect, 60_000);
        }
      });
    };
    connect();
    return () => {
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [qc, workspaceId]);
};
