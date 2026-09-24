import { Readable } from 'node:stream';
import { folderEndpoints as F, mediaEndpoints as E } from '@castlane/api-contracts';
import {
  abortUpload,
  archiveAsset,
  archiveFolder,
  assetActivity,
  assetArchivePreview,
  bulkAssetApply,
  bulkAssetPreview,
  completeUpload,
  createExternalLinkAsset,
  createFolder,
  deleteAssetVersion,
  findDuplicates,
  folderArchivePreview,
  getAsset,
  getFolder,
  initiateUpload,
  issueDownload,
  linkAsset,
  linkTargetTypes,
  listAssets,
  listEntityFiles,
  listFolders,
  listOpenUploads,
  loadDerivative,
  loadVersionForStream,
  moveFolder,
  removeAssetLink,
  renameFolder,
  restoreAsset,
  restoreFolder,
  resumeUpload,
  storageUsage,
  updateAsset,
  versionDeletePreview,
} from '@castlane/application';
import { route } from '../http/router';

const safeFilename = (name: string) => name.replace(/[^\w.\- ]+/g, '_').slice(0, 150) || 'file';

route(E.initiateUpload, ({ run, input }) => run((c) => initiateUpload(c, input.body)));
route(E.resumeUpload, ({ ctx, input }) => resumeUpload(ctx, input.params.uploadId));
route(E.listOpenUploads, ({ ctx }) => listOpenUploads(ctx));
route(E.completeUpload, ({ run, input }) => run((c) => completeUpload(c, input.params.uploadId, input.body.parts)));
route(E.abortUpload, ({ run, input }) => run((c) => abortUpload(c, input.params.uploadId)));
route(E.storageUsage, ({ ctx }) => storageUsage(ctx));
route(E.duplicates, ({ ctx, input }) => findDuplicates(ctx, input.query.checksum));
route(E.list, ({ ctx, input }) => listAssets(ctx, input.query));
route(E.get, ({ ctx, input }) => getAsset(ctx, input.params.assetId));
route(E.activity, ({ ctx, input }) => assetActivity(ctx, input.params.assetId, input.query));
route(E.update, ({ run, input }) => run((c) => updateAsset(c, input.params.assetId, input.body)));
route(E.archivePreview, ({ ctx, input }) => assetArchivePreview(ctx, input.params.assetId));
route(E.archive, ({ run, input }) => run((c) => archiveAsset(c, input.params.assetId, input.body.reason)));
route(E.restore, ({ run, input }) => run((c) => restoreAsset(c, input.params.assetId)));
route(E.versionDeletePreview, ({ ctx, input }) => versionDeletePreview(ctx, input.params.assetId, input.params.versionId));
route(E.deleteVersion, ({ run, input }) =>
  run(async (c) => getAsset(c, await deleteAssetVersion(c, input.params.assetId, input.params.versionId, input.body.reason))),
);
route(E.download, ({ ctx, input }) => issueDownload(ctx, input.params.assetId, input.body.versionId, input.body.disposition));
route(E.linkTargets, async () => linkTargetTypes());
route(E.link, ({ run, input }) => run((c) => linkAsset(c, input.params.assetId, { versionId: input.body.versionId, target: input.body.target })));
route(E.removeLink, ({ run, input }) => run((c) => removeAssetLink(c, input.params.linkId, input.body.reason)));
route(E.entityFiles, ({ ctx, input }) => listEntityFiles(ctx, input.params.entityType, input.params.entityId));
route(E.externalLink, ({ run, input }) => run((c) => createExternalLinkAsset(c, input.body)));
route(E.bulkPreview, ({ run, input }) => run((c) => bulkAssetPreview(c, input.body)));
route(E.bulkApply, ({ run, input }) => run((c) => bulkAssetApply(c, input.body)));

route(F.list, ({ ctx, input }) => listFolders(ctx, input.query));
route(F.get, ({ ctx, input }) => getFolder(ctx, input.params.folderId));
route(F.create, ({ run, input }) => run(async (c) => getFolder(c, await createFolder(c, input.body))));
route(F.update, ({ run, input }) => run(async (c) => getFolder(c, await renameFolder(c, input.params.folderId, input.body))));
route(F.move, ({ run, input }) => run(async (c) => getFolder(c, await moveFolder(c, input.params.folderId, input.body))));
route(F.archivePreview, ({ ctx, input }) => folderArchivePreview(ctx, input.params.folderId));
route(F.archive, ({ run, input }) => run(async (c) => getFolder(c, await archiveFolder(c, input.params.folderId, input.body))));
route(F.restore, ({ run, input }) => run(async (c) => getFolder(c, await restoreFolder(c, input.params.folderId))));

/** Authorised derivative stream; private cache only (never a shared CDN). */
route(E.thumbnail, async ({ ctx, input, res }) => {
  const d = await loadDerivative(ctx, input.params.assetId, input.query.size, input.query.versionId, input.query.reveal);
  const obj = await ctx.app.storage.getObjectStream(d.storageKey);
  res.raw = new Response(Readable.toWeb(obj.stream) as ReadableStream, {
    headers: {
      'content-type': d.mime,
      // Revealed restricted previews are never cached.
      'cache-control': input.query.reveal ? 'private, no-store' : 'private, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
  return null;
});

/** Streaming proxy with Range support for originals (restricted media, filesystem driver, previews). */
route(E.content, async ({ ctx, input, http, res }) => {
  const { version } = await loadVersionForStream(ctx, input.params.assetId, input.params.versionId, input.query.token);
  const size = version.byteSize ?? 0;
  const range = http.headers.get('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  const start = m && m[1] ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  const obj = await ctx.app.storage.getObjectStream(version.storageKey!, m ? { start, end } : undefined);
  const mime = version.detectedMime ?? 'application/octet-stream';
  // Never render user files as active content in the app origin.
  const inlineSafe = /^(image\/(jpeg|png|webp|gif)|video\/|audio\/)/.test(mime);
  const disposition = input.query.disposition === 'inline' && inlineSafe ? 'inline' : 'attachment';
  res.raw = new Response(Readable.toWeb(obj.stream) as ReadableStream, {
    status: m ? 206 : 200,
    headers: {
      'content-type': mime,
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
      'content-disposition': `${disposition}; filename="${safeFilename(version.originalFilename)}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
  return null;
});
