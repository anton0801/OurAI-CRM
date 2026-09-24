# Tasks, time, workload, My Work & comments (S09, S27–S30)

Code: `packages/application/src/work/`, contracts `packages/api-contracts/src/work/`, handlers `work.ts`.

Helpers:
* `applyTaskTemplate(ctx, { templateVersionId, targetType, targetId, projectId, accountId?, startDate, applicationKey, assignees?, timezone? })`
  — creates tasks with dependencies/checklists once per application key (T036). Use it for content templates, deal deliverables, episodes.
* Comments: `defineCommentParent(type, { readPermission, commentPermission, scope })` + `<CommentThread>` from `apps/web/src/components/comments/comment-thread.tsx`.
* Endpoint id prefixes: `tasks.`, `recurrences.`, `reminders.`, `time.`, `workload.`, `myWork.`, `comments.`.

Registries: lookup task; link access task; archive (trash drafts); responsibility `tasks.assignee`, `tasks.reviewer`,
`time.sheet_approvals`, `time.running_timer`; import `tasks`; export `tasks`, `time_entries`; schedules `work.recurrence`,
`work.reminders`, `work.timers`. Renders `MY_WORK_SECTIONS`; contributes project/account/member tabs.

Limits: no Timeline view; Time and Workload are reached from Tasks/My Work menus.
