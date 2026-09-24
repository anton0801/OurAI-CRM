import { contentEndpoints as E, contentVersionEndpoints as V, reviewEndpoints as R } from '@castlane/api-contracts';
import {
  applyContentTemplate,
  approveReview,
  assignReviewReviewer,
  attachVersionFile,
  contentActivity,
  contentBoard,
  createContent,
  createContentVersion,
  duplicateContent,
  episodeContent,
  getContent,
  getContentVersion,
  getExport,
  getReview,
  listContent,
  listContentPackages,
  listContentVersions,
  listReviewQueue,
  previewContentTemplate,
  bulkContentApply,
  bulkContentPreview,
  removeVersionFile,
  resolveContentVersion,
  requestContentPackage,
  requestEpisodePackage,
  requestReviewChanges,
  revokeReviewApproval,
  setContentFlag,
  setContentWipLimits,
  submitContentVersion,
  transitionContent,
  updateContent,
  updateContentVersion,
} from '@castlane/application';
import { route } from '../http/router';

// ——— Content (S22–S24) ———
route(E.list, ({ ctx, input }) => listContent(ctx, input.query));
route(E.board, ({ ctx, input }) => contentBoard(ctx, input.query));
route(E.setWipLimits, ({ run, input }) => run((c) => setContentWipLimits(c, input.body)));
route(E.get, ({ ctx, input }) => getContent(ctx, input.params.contentId));
route(E.create, ({ run, input }) =>
  run(async (c) => {
    const { applyTemplate, ...body } = input.body;
    const id = await createContent(c, body);
    if (applyTemplate) await applyContentTemplate(c, id, { ...applyTemplate }, { skipVersion: true, skipToken: true });
    return getContent(c, id);
  }),
);
route(E.update, ({ run, input }) => run(async (c) => getContent(c, await updateContent(c, input.params.contentId, input.body))));
route(E.transition, ({ run, input }) =>
  run(async (c) => {
    const r = await transitionContent(c, input.params.contentId, input.body);
    return { ...(await getContent(c, r.id)), warnings: r.warnings };
  }),
);
route(E.setFlag, ({ run, input }) => run(async (c) => getContent(c, await setContentFlag(c, input.params.contentId, input.body))));
route(E.duplicate, ({ run, input }) => run(async (c) => getContent(c, await duplicateContent(c, input.params.contentId, input.body))));
route(E.activity, ({ ctx, input }) => contentActivity(ctx, input.params.contentId, input.query));
route(E.templatePreview, ({ ctx, input }) => previewContentTemplate(ctx, input.params.contentId, input.body));
route(E.applyTemplate, ({ run, input }) =>
  run(async (c) => {
    const r = await applyContentTemplate(c, input.params.contentId, input.body);
    return { ...r, content: await getContent(c, input.params.contentId) };
  }),
);
route(E.bulkPreview, ({ run, input }) => run((c) => bulkContentPreview(c, input.body)));
route(E.bulkApply, ({ run, input }) => run((c) => bulkContentApply(c, input.body)));
route(E.requestPackage, ({ run, input }) => run(async (c) => getExport(c, await requestContentPackage(c, input.params.contentId, input.body))));
route(E.requestEpisodePackage, ({ run, input }) => run(async (c) => getExport(c, await requestEpisodePackage(c, input.params.episodeId))));
route(E.packages, async ({ ctx, input }) => {
  const ids = await listContentPackages(ctx, input.params.contentId);
  const out = [];
  for (const id of ids) out.push(await getExport(ctx, id));
  return out;
});
route(E.episodeContent, ({ ctx, input }) => episodeContent(ctx, input.params.episodeId));

// ——— Versions ———
route(V.list, ({ ctx, input }) => listContentVersions(ctx, input.params.contentId));
route(V.resolve, ({ ctx, input }) => resolveContentVersion(ctx, input.params.versionId));
route(V.get, ({ ctx, input }) => getContentVersion(ctx, input.params.contentId, input.params.versionId));
route(V.create, ({ run, input }) => run(async (c) => getContentVersion(c, input.params.contentId, await createContentVersion(c, input.params.contentId, input.body))));
route(V.update, ({ run, input }) => run(async (c) => getContentVersion(c, input.params.contentId, await updateContentVersion(c, input.params.contentId, input.params.versionId, input.body))));
route(V.attachFile, ({ run, input }) => run(async (c) => getContentVersion(c, input.params.contentId, await attachVersionFile(c, input.params.contentId, input.params.versionId, input.body))));
route(V.removeFile, ({ run, input }) =>
  run(async (c) => getContentVersion(c, input.params.contentId, await removeVersionFile(c, input.params.contentId, input.params.versionId, input.params.fileId))),
);
route(V.submit, ({ run, input }) => run(async (c) => getContent(c, await submitContentVersion(c, input.params.contentId, input.body))));

// ——— Reviews (S25–S26) ———
route(R.list, ({ ctx, input }) => listReviewQueue(ctx, input.query));
route(R.get, ({ ctx, input }) => getReview(ctx, input.params.reviewId));
route(R.approve, ({ run, input }) => run(async (c) => getReview(c, await approveReview(c, input.params.reviewId, input.body))));
route(R.requestChanges, ({ run, input }) => run(async (c) => getReview(c, await requestReviewChanges(c, input.params.reviewId, input.body))));
route(R.revoke, ({ run, input }) => run(async (c) => getReview(c, await revokeReviewApproval(c, input.params.reviewId, input.body))));
route(R.assign, ({ run, input }) => run(async (c) => getReview(c, await assignReviewReviewer(c, input.params.reviewId, input.body))));

