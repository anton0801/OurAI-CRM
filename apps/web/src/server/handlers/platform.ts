import { Readable } from 'node:stream';
import {
  archiveEndpoints as AR,
  auditEndpoints as AU,
  customFieldEndpoints as CF,
  exportEndpoints as EX,
  healthEndpoints as HE,
  importEndpoints as IM,
  inboxEndpoints as IN,
  incidentEndpoints as IC,
  savedViewEndpoints as SV,
  searchEndpoints as SE,
  templateEndpoints as TE,
} from '@castlane/api-contracts';
import {
  acknowledgeIncident,
  archiveCustomField,
  archiveEntities,
  archivePreview,
  archiveTypes,
  assignIncident,
  auditFacets,
  cancelExport,
  cancelImport,
  cancelJob,
  createCustomField,
  createImport,
  createIncident,
  createSavedView,
  createTemplate,
  deleteExportFile,
  getAuditEvent,
  getCustomField,
  getCustomFieldValues,
  getExport,
  getImport,
  getIncident,
  getSavedView,
  getTemplate,
  importErrorReport,
  importTemplate,
  importUndoPreview,
  initiateImportUpload,
  issueExportDownload,
  listArchive,
  listAuditEvents,
  listBackupRuns,
  listCustomFields,
  listCustomFieldTargets,
  listExportDatasets,
  listExports,
  listImportDatasets,
  listImportMappings,
  listImportRows,
  listImports,
  listIncidents,
  listJobs,
  listMail,
  listNotifications,
  listSavedViews,
  listTemplates,
  liveness,
  loadExportForDownload,
  markNotificationsRead,
  markReadPreview,
  newTemplateVersion,
  notificationFacets,
  previewExport,
  previewTemplateApplication,
  publishTemplate,
  purgePreview,
  readiness,
  recordRestoreDrill,
  removeSavedView,
  reopenIncident,
  reparseImport,
  replaceCustomField,
  replaceCustomFieldPreview,
  requestExport,
  requestImportCommit,
  requestImportValidation,
  requestPurge,
  resolveIncident,
  restoreEntities,
  restorePreview,
  retryExport,
  retryJob,
  saveImportMapping,
  saveTemplateDraft,
  searchPage,
  setCustomFieldValues,
  setNotificationArchived,
  setNotificationRead,
  setTemplateDisabled,
  systemHealth,
  trashEntities,
  undoImport,
  updateCustomField,
  updateIncident,
  updateSavedView,
  updateTemplate,
} from '@castlane/application';
import { route } from '../http/router';

const safeFilename = (name: string) => name.replace(/[^\w.\- ]+/g, '_').slice(0, 150) || 'file';

const fileResponse = (body: Buffer | ReadableStream, fileName: string, contentType: string) =>
  new Response(body as BodyInit, {
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="${safeFilename(fileName)}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });

// ——— Health (public) ———
route(HE.live, async ({ res }) => {
  res.headers['cache-control'] = 'no-store';
  return liveness();
});
route(HE.ready, async ({ app, res }) => {
  const r = await readiness(app);
  if (r.status !== 'ready') res.status = 503;
  return r;
});

// ——— Inbox ———
route(IN.facets, ({ ctx }) => notificationFacets(ctx));
route(IN.list, ({ ctx, input }) => listNotifications(ctx, input.query));
route(IN.markReadPreview, ({ ctx, input }) => markReadPreview(ctx, input.body));
route(IN.markRead, ({ run, input }) => run((c) => markNotificationsRead(c, input.body)));
route(IN.setRead, ({ run, input }) => run((c) => setNotificationRead(c, input.params.notificationId, input.body.read)));
route(IN.setArchived, ({ run, input }) => run((c) => setNotificationArchived(c, input.params.notificationId, input.body.archived)));

// ——— Search page ———
route(SE.page, ({ ctx, input }) => searchPage(ctx, input.query));

// ——— Saved views ———
route(SV.list, ({ ctx, input }) => listSavedViews(ctx, input.query.module));
route(SV.create, ({ run, input }) => run(async (c) => getSavedView(c, await createSavedView(c, input.body))));
route(SV.update, ({ run, input }) => run(async (c) => getSavedView(c, await updateSavedView(c, input.params.viewId, input.body))));
route(SV.remove, ({ run, input }) => run((c) => removeSavedView(c, input.params.viewId)));

// ——— Audit ———
route(AU.facets, ({ ctx }) => auditFacets(ctx));
route(AU.list, ({ ctx, input }) => listAuditEvents(ctx, input.query));
route(AU.get, ({ ctx, input }) => getAuditEvent(ctx, input.params.eventId));

// ——— Archive / Trash ———
route(AR.types, async ({ ctx }) => archiveTypes(ctx));
route(AR.list, ({ ctx, input }) => listArchive(ctx, input.query));
route(AR.archivePreview, ({ ctx, input }) => archivePreview(ctx, input.body.targets));
route(AR.archive, ({ run, input }) => run((c) => archiveEntities(c, input.body)));
route(AR.trash, ({ run, input }) => run((c) => trashEntities(c, input.body)));
route(AR.restorePreview, ({ ctx, input }) => restorePreview(ctx, input.body.targets));
route(AR.restore, ({ run, input }) => run((c) => restoreEntities(c, input.body)));
route(AR.purgePreview, ({ ctx, input }) => purgePreview(ctx, input.body.targets));
route(AR.purge, ({ run, input }) => run((c) => requestPurge(c, input.body)));

// ——— System health ———
route(HE.system, ({ ctx }) => systemHealth(ctx));
route(HE.jobs, ({ ctx, input }) => listJobs(ctx, input.query));
route(HE.retryJob, ({ run, input }) => run((c) => retryJob(c, input.params.jobId, input.body.reason)));
route(HE.cancelJob, ({ run, input }) => run((c) => cancelJob(c, input.params.jobId, input.body.reason)));
route(HE.mail, ({ ctx, input }) => listMail(ctx, input.query));
route(HE.backups, ({ ctx, input }) => listBackupRuns(ctx, input.query.kind));
route(HE.recordRestoreDrill, ({ run, input }) => run((c) => recordRestoreDrill(c, input.body)));

// ——— Incidents ———
route(IC.list, ({ ctx, input }) => listIncidents(ctx, input.query));
route(IC.get, ({ ctx, input }) => getIncident(ctx, input.params.incidentId));
route(IC.create, ({ run, input }) => run(async (c) => getIncident(c, await createIncident(c, input.body))));
route(IC.update, ({ run, input }) => run(async (c) => getIncident(c, await updateIncident(c, input.params.incidentId, input.body))));
route(IC.acknowledge, ({ run, input }) => run(async (c) => getIncident(c, await acknowledgeIncident(c, input.params.incidentId))));
route(IC.assign, ({ run, input }) => run(async (c) => getIncident(c, await assignIncident(c, input.params.incidentId, input.body.ownerMembershipId))));
route(IC.resolve, ({ run, input }) => run(async (c) => getIncident(c, await resolveIncident(c, input.params.incidentId, input.body))));
route(IC.reopen, ({ run, input }) => run(async (c) => getIncident(c, await reopenIncident(c, input.params.incidentId, input.body.reason))));

// ——— Import Center (literal segments before {importId}) ———
route(IM.datasets, async ({ ctx }) => listImportDatasets(ctx));
route(IM.template, async ({ ctx, input, res }) => {
  const t = await importTemplate(ctx, input.params.dataset, input.query.format);
  res.raw = fileResponse(t.body, t.fileName, t.contentType);
  return null;
});
route(IM.mappings, ({ ctx, input }) => listImportMappings(ctx, input.params.dataset));
route(IM.saveMapping, ({ run, input }) => run((c) => saveImportMapping(c, input.params.dataset, input.body)));
route(IM.initiateUpload, ({ run, input }) => run((c) => initiateImportUpload(c, input.body)));
route(IM.create, ({ run, input }) => run(async (c) => getImport(c, await createImport(c, input.body))));
route(IM.list, ({ ctx, input }) => listImports(ctx, input.query));
route(IM.get, ({ ctx, input }) => getImport(ctx, input.params.importId));
route(IM.rows, ({ ctx, input }) => listImportRows(ctx, input.params.importId, input.query));
route(IM.validate, ({ run, input }) => run(async (c) => getImport(c, await requestImportValidation(c, input.params.importId, input.body))));
route(IM.reparse, ({ run, input }) => run(async (c) => getImport(c, await reparseImport(c, input.params.importId, input.body.delimiter))));
route(IM.commit, ({ run, input }) => run(async (c) => getImport(c, await requestImportCommit(c, input.params.importId, input.body))));
route(IM.cancel, ({ run, input }) => run(async (c) => getImport(c, await cancelImport(c, input.params.importId, input.body.reason))));
route(IM.errorReport, async ({ ctx, input, res }) => {
  const r = await importErrorReport(ctx, input.params.importId);
  res.raw = fileResponse(r.body, r.fileName, 'text/csv; charset=utf-8');
  return null;
});
route(IM.undoPreview, ({ ctx, input }) => importUndoPreview(ctx, input.params.importId, input.body.reason));
route(IM.undo, ({ run, input }) => run(async (c) => getImport(c, await undoImport(c, input.params.importId, input.body.previewToken))));

// ——— Export Center (literal segments before {exportId}) ———
route(EX.datasets, async ({ ctx }) => listExportDatasets(ctx));
route(EX.preview, ({ ctx, input }) => previewExport(ctx, input.body));
route(EX.create, ({ run, input }) => run(async (c) => getExport(c, await requestExport(c, input.body))));
route(EX.list, ({ ctx, input }) => listExports(ctx, input.query));
route(EX.get, ({ ctx, input }) => getExport(ctx, input.params.exportId));
route(EX.download, ({ run, input }) => run((c) => issueExportDownload(c, input.params.exportId)));
/** Authorised stream: the link token and the member's current permissions are both checked now. */
route(EX.file, async ({ ctx, input, res }) => {
  const f = await loadExportForDownload(ctx, input.params.exportId, input.query.token);
  const obj = await ctx.app.storage.getObjectStream(f.storageKey);
  res.raw = fileResponse(Readable.toWeb(obj.stream) as ReadableStream, f.fileName, f.contentType);
  return null;
});
route(EX.cancel, ({ run, input }) => run(async (c) => getExport(c, await cancelExport(c, input.params.exportId))));
route(EX.remove, ({ run, input }) => run(async (c) => getExport(c, await deleteExportFile(c, input.params.exportId))));
route(EX.retry, ({ run, input }) => run(async (c) => getExport(c, await retryExport(c, input.params.exportId))));

// ——— Templates ———
route(TE.list, ({ ctx, input }) => listTemplates(ctx, input.query));
route(TE.get, ({ ctx, input }) => getTemplate(ctx, input.params.templateId));
route(TE.create, ({ run, input }) => run(async (c) => getTemplate(c, await createTemplate(c, input.body))));
route(TE.update, ({ run, input }) => run(async (c) => getTemplate(c, await updateTemplate(c, input.params.templateId, input.body))));
route(TE.saveDraft, ({ run, input }) => run(async (c) => getTemplate(c, await saveTemplateDraft(c, input.params.templateId, input.params.versionId, input.body.config))));
route(TE.newVersion, ({ run, input }) => run(async (c) => getTemplate(c, await newTemplateVersion(c, input.params.templateId, input.body.fromVersionId))));
route(TE.publish, ({ run, input }) => run(async (c) => getTemplate(c, await publishTemplate(c, input.params.templateId, input.body.draftVersionId))));
route(TE.disable, ({ run, input }) => run(async (c) => getTemplate(c, await setTemplateDisabled(c, input.params.templateId, true, input.body.reason))));
route(TE.enable, ({ run, input }) => run(async (c) => getTemplate(c, await setTemplateDisabled(c, input.params.templateId, false))));
route(TE.previewApplication, ({ ctx, input }) => previewTemplateApplication(ctx, input.params.templateId, input.body));

// ——— Custom fields (targets before {fieldId}) ———
route(CF.targets, ({ ctx }) => listCustomFieldTargets(ctx));
route(CF.list, ({ ctx, input }) => listCustomFields(ctx, input.query));
route(CF.get, ({ ctx, input }) => getCustomField(ctx, input.params.fieldId));
route(CF.create, ({ run, input }) => run(async (c) => getCustomField(c, await createCustomField(c, input.body))));
route(CF.update, ({ run, input }) => run(async (c) => getCustomField(c, await updateCustomField(c, input.params.fieldId, input.body))));
route(CF.archive, ({ run, input }) => run(async (c) => getCustomField(c, await archiveCustomField(c, input.params.fieldId, input.body.reason))));
route(CF.replacePreview, ({ ctx, input }) => replaceCustomFieldPreview(ctx, input.params.fieldId, input.body));
route(CF.replace, ({ run, input }) => run(async (c) => getCustomField(c, await replaceCustomField(c, input.params.fieldId, input.body))));
route(CF.values, ({ ctx, input }) => getCustomFieldValues(ctx, input.query.entityType, input.query.entityId));
route(CF.setValues, ({ run, input }) => run((c) => setCustomFieldValues(c, input.body)));
