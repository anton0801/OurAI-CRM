import {
  commentEndpoints as C,
  myWorkEndpoints as MW,
  recurrenceEndpoints as R,
  reminderEndpoints as RM,
  taskEndpoints as T,
  timeEndpoints as TM,
  workloadEndpoints as W,
} from '@castlane/api-contracts';
import {
  acceptTaskCancellation,
  addChecklistItem,
  addDependency,
  applyReschedule,
  applyTaskTemplate,
  approveTimeEntry,
  approveTimeSheet,
  archiveRecurrence,
  blockTask,
  bulkApply,
  bulkPreview,
  cancelAbsence,
  closeTimer,
  commentHistory,
  countTasks,
  createAbsence,
  createComment,
  createRecurrence,
  createReminder,
  createSubtask,
  createTask,
  createTimeEntry,
  currentTimer,
  decideAbsence,
  deleteTaskView,
  discardTimeEntry,
  dismissReminder,
  duplicateTask,
  followTask,
  getComment,
  getMyWork,
  getRecurrence,
  getTask,
  getTimeEntry,
  getTimeSheet,
  getWeek,
  getWorkload,
  listAbsences,
  listCapacities,
  listComments,
  listDependencies,
  listRecurrences,
  listReminders,
  listTasks,
  listTaskViews,
  listTemplateOptions,
  listTimeEntries,
  listTimeSheets,
  previewRecurrence,
  previewRecurrenceChange,
  previewTaskTemplate,
  reassignPreview,
  removeChecklistItem,
  removeComment,
  removeDependency,
  reopenComment,
  reschedulePreview,
  resolveComment,
  returnTimeSheet,
  reviseTimeEntry,
  saveTaskView,
  setAllocation,
  setCapacity,
  setRecurrenceActive,
  snoozeReminder,
  startTimer,
  stopTimer,
  submitWeek,
  taskActivity,
  taskAttachments,
  transitionTask,
  unblockTask,
  updateAbsence,
  updateCapacity,
  updateChecklistItem,
  updateComment,
  updateRecurrence,
  updateTask,
  updateTimeEntry,
} from '@castlane/application';
import { route } from '../http/router';

// ——— Tasks ———
route(T.list, ({ ctx, input }) => listTasks(ctx, input.query));
route(T.count, ({ ctx, input }) => countTasks(ctx, input.query));
route(T.get, ({ ctx, input }) => getTask(ctx, input.params.taskId));
route(T.create, ({ run, input }) => run(async (c) => getTask(c, await createTask(c, input.body))));
route(T.update, ({ run, input }) => run(async (c) => getTask(c, await updateTask(c, input.params.taskId, input.body))));
route(T.transition, ({ run, input }) => run(async (c) => getTask(c, await transitionTask(c, input.params.taskId, input.body))));
route(T.block, ({ run, input }) => run(async (c) => getTask(c, await blockTask(c, input.params.taskId, input.body))));
route(T.unblock, ({ run, input }) => run(async (c) => getTask(c, await unblockTask(c, input.params.taskId, input.body))));
route(T.acceptCancellation, ({ run, input }) => run(async (c) => getTask(c, await acceptTaskCancellation(c, input.params.taskId, input.body))));
route(T.createSubtask, ({ run, input }) => run(async (c) => getTask(c, await createSubtask(c, input.params.taskId, input.body))));
route(T.duplicate, ({ run, input }) => run(async (c) => getTask(c, await duplicateTask(c, input.params.taskId, input.body))));
route(T.follow, ({ run, input }) => run((c) => followTask(c, input.params.taskId, input.body.following)));
route(T.addChecklistItem, ({ run, input }) => run((c) => addChecklistItem(c, input.params.taskId, input.body)));
route(T.updateChecklistItem, ({ run, input }) => run((c) => updateChecklistItem(c, input.params.taskId, input.params.itemId, input.body)));
route(T.removeChecklistItem, ({ run, input }) => run((c) => removeChecklistItem(c, input.params.taskId, input.params.itemId)));
route(T.dependencies, ({ ctx, input }) => listDependencies(ctx, input.params.taskId));
route(T.addDependency, ({ run, input }) => run((c) => addDependency(c, input.params.taskId, input.body.predecessorId)));
route(T.removeDependency, ({ run, input }) => run((c) => removeDependency(c, input.params.taskId, input.params.dependencyId, input.body.reason)));
route(T.reschedulePreview, ({ run, input }) => run((c) => reschedulePreview(c, input.params.taskId, input.body)));
route(T.reschedule, ({ run, input }) => run(async (c) => getTask(c, await applyReschedule(c, input.params.taskId, input.body))));
route(T.attachments, ({ ctx, input }) => taskAttachments(ctx, input.params.taskId));
route(T.activity, ({ ctx, input }) => taskActivity(ctx, input.params.taskId, input.query));
route(T.bulkPreview, ({ run, input }) => run((c) => bulkPreview(c, input.body)));
route(T.bulkApply, ({ run, input }) => run((c) => bulkApply(c, input.body)));
route(T.templateOptions, ({ ctx, input }) => listTemplateOptions(ctx, input.query));
route(T.templatePreview, ({ ctx, input }) => previewTaskTemplate(ctx, input.body));
route(T.applyTemplate, ({ run, input }) => run((c) => applyTaskTemplate(c, input.body)));
route(T.views, ({ ctx }) => listTaskViews(ctx));
route(T.saveView, ({ run, input }) => run((c) => saveTaskView(c, input.body)));
route(T.deleteView, ({ run, input }) => run((c) => deleteTaskView(c, input.params.viewId)));

// ——— Recurring tasks ———
route(R.list, ({ ctx, input }) => listRecurrences(ctx, input.query));
route(R.get, ({ ctx, input }) => getRecurrence(ctx, input.params.ruleId));
route(R.preview, async ({ ctx, input }) =>
  previewRecurrence(ctx, {
    cadence: input.body.cadence,
    intervalCount: input.body.intervalCount,
    weekdays: input.body.weekdays,
    monthDay: input.body.monthDay ?? null,
    monthDayPolicy: input.body.monthDayPolicy,
    localTime: input.body.localTime,
    timezone: input.body.timezone,
    startsOn: input.body.startsOn,
    endsOn: input.body.endsOn ?? null,
  }),
);
route(R.create, ({ run, input }) => run(async (c) => getRecurrence(c, await createRecurrence(c, input.body))));
route(R.changePreview, ({ ctx, input }) => previewRecurrenceChange(ctx, input.params.ruleId, input.body));
route(R.update, ({ run, input }) =>
  run(async (c) => {
    const r = await updateRecurrence(c, input.params.ruleId, input.body);
    return { ...(await getRecurrence(c, r.id)), diff: r.diff };
  }),
);
route(R.setActive, ({ run, input }) => run(async (c) => getRecurrence(c, await setRecurrenceActive(c, input.params.ruleId, input.body.active))));
route(R.archive, ({ run, input }) => run(async (c) => getRecurrence(c, await archiveRecurrence(c, input.params.ruleId, input.body))));

// ——— Personal reminders ———
route(RM.list, ({ ctx, input }) => listReminders(ctx, input.query));
route(RM.create, ({ run, input }) => run((c) => createReminder(c, input.body)));
route(RM.snooze, ({ run, input }) => run((c) => snoozeReminder(c, input.params.reminderId, input.body.until)));
route(RM.dismiss, ({ run, input }) => run((c) => dismissReminder(c, input.params.reminderId)));

// ——— Time ———
route(TM.currentTimer, ({ ctx }) => currentTimer(ctx));
route(TM.startTimer, ({ run, input }) => run((c) => startTimer(c, input.body)));
route(TM.stopTimer, ({ run, input }) => run((c) => stopTimer(c, input.params.timerId, input.body)));
route(TM.closeTimer, ({ run, input }) => run((c) => closeTimer(c, input.params.timerId, input.body)));
route(TM.list, ({ ctx, input }) => listTimeEntries(ctx, input.query));
route(TM.get, ({ ctx, input }) => getTimeEntry(ctx, input.params.entryId));
route(TM.create, ({ run, input }) => run((c) => createTimeEntry(c, input.body)));
route(TM.update, ({ run, input }) => run((c) => updateTimeEntry(c, input.params.entryId, input.body)));
route(TM.discard, ({ run, input }) => run((c) => discardTimeEntry(c, input.params.entryId)));
route(TM.revise, ({ run, input }) => run((c) => reviseTimeEntry(c, input.params.entryId, input.body)));
route(TM.approve, ({ run, input }) => run((c) => approveTimeEntry(c, input.params.entryId, input.body)));
route(TM.week, ({ ctx, input }) => getWeek(ctx, input.query));
route(TM.submitWeek, ({ run, input }) => run((c) => submitWeek(c, input.body)));
route(TM.sheets, ({ ctx, input }) => listTimeSheets(ctx, input.query));
route(TM.sheet, ({ ctx, input }) => getTimeSheet(ctx, input.params.sheetId));
route(TM.approveSheet, ({ run, input }) => run((c) => approveTimeSheet(c, input.params.sheetId, input.body)));
route(TM.returnSheet, ({ run, input }) => run((c) => returnTimeSheet(c, input.params.sheetId, input.body)));

// ——— Workload ———
route(W.get, ({ ctx, input }) => getWorkload(ctx, input.query));
route(W.reassignPreview, ({ ctx, input }) => reassignPreview(ctx, input.body));
route(W.setAllocation, ({ run, input }) => run((c) => setAllocation(c, input.body)));
route(W.capacities, ({ ctx, input }) => listCapacities(ctx, input.query.membershipId));
route(W.setCapacity, ({ run, input }) => run((c) => setCapacity(c, input.body)));
route(W.updateCapacity, ({ run, input }) => run((c) => updateCapacity(c, input.params.capacityId, input.body)));
route(W.absences, ({ ctx, input }) => listAbsences(ctx, input.query));
route(W.createAbsence, ({ run, input }) => run((c) => createAbsence(c, input.body)));
route(W.updateAbsence, ({ run, input }) => run((c) => updateAbsence(c, input.params.absenceId, input.body)));
route(W.decideAbsence, ({ run, input }) => run((c) => decideAbsence(c, input.params.absenceId, input.body)));
route(W.cancelAbsence, ({ run, input }) => run((c) => cancelAbsence(c, input.params.absenceId, input.body)));

// ——— My Work ———
route(MW.get, ({ ctx, input }) => getMyWork(ctx, input.query));

// ——— Comments ———
route(C.list, ({ ctx, input }) => listComments(ctx, input.query));
route(C.get, ({ ctx, input }) => getComment(ctx, input.params.commentId));
route(C.create, ({ run, input }) => run((c) => createComment(c, input.body)));
route(C.update, ({ run, input }) => run((c) => updateComment(c, input.params.commentId, input.body)));
route(C.resolve, ({ run, input }) => run((c) => resolveComment(c, input.params.commentId, input.body)));
route(C.reopen, ({ run, input }) => run((c) => reopenComment(c, input.params.commentId, input.body)));
route(C.remove, ({ run, input }) => run((c) => removeComment(c, input.params.commentId, input.body)));
route(C.revisions, ({ ctx, input }) => commentHistory(ctx, input.params.commentId));
