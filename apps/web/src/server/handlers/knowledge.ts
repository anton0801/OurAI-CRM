import { knowledgeEndpoints as E } from '@castlane/api-contracts';
import {
  acknowledgeArticle,
  archiveArticle,
  archiveCategory,
  articleArchivePreview,
  assignReading,
  cancelReading,
  compareArticleVersions,
  createArticle,
  createCategory,
  createTaskFromChecklist,
  discardDraft,
  getArticle,
  getArticleVersion,
  getCategoryView,
  listArticles,
  listArticleVersions,
  listCategories,
  listReadingStatus,
  markArticleReviewed,
  myReading,
  publishArticle,
  readingAudiences,
  restoreArticle,
  restoreCategory,
  revertArticle,
  updateArticle,
  updateCategory,
} from '@castlane/application';
import { route } from '../http/router';

route(E.listCategories, ({ ctx, input }) => listCategories(ctx, input.query));
route(E.createCategory, ({ run, input }) => run(async (c) => getCategoryView(c, await createCategory(c, input.body))));
route(E.updateCategory, ({ run, input }) => run(async (c) => getCategoryView(c, await updateCategory(c, input.params.categoryId, input.body))));
route(E.archiveCategory, ({ run, input }) => run(async (c) => getCategoryView(c, await archiveCategory(c, input.params.categoryId, input.body.reason))));
route(E.restoreCategory, ({ run, input }) => run(async (c) => getCategoryView(c, await restoreCategory(c, input.params.categoryId))));

route(E.list, ({ ctx, input }) => listArticles(ctx, input.query));
route(E.get, ({ ctx, input }) => getArticle(ctx, input.params.articleId));
// Commands return the fresh read model built inside the same transaction.
route(E.create, ({ run, input }) => run(async (c) => getArticle(c, await createArticle(c, input.body))));
route(E.update, ({ run, input }) => run(async (c) => getArticle(c, await updateArticle(c, input.params.articleId, input.body))));
route(E.publish, ({ run, input }) => run(async (c) => getArticle(c, await publishArticle(c, input.params.articleId, input.body))));
route(E.discardDraft, ({ run, input }) => run(async (c) => getArticle(c, await discardDraft(c, input.params.articleId))));
route(E.revert, ({ run, input }) => run(async (c) => getArticle(c, await revertArticle(c, input.params.articleId, input.body))));
route(E.markReviewed, ({ run, input }) => run(async (c) => getArticle(c, await markArticleReviewed(c, input.params.articleId, input.body))));
route(E.archivePreview, ({ ctx, input }) => articleArchivePreview(ctx, input.params.articleId));
route(E.archive, ({ run, input }) => run(async (c) => getArticle(c, await archiveArticle(c, input.params.articleId, input.body))));
route(E.restore, ({ run, input }) => run(async (c) => getArticle(c, await restoreArticle(c, input.params.articleId))));
route(E.versions, ({ ctx, input }) => listArticleVersions(ctx, input.params.articleId));
route(E.version, ({ ctx, input }) => getArticleVersion(ctx, input.params.articleId, input.params.versionId));
route(E.compare, ({ ctx, input }) => compareArticleVersions(ctx, input.params.articleId, input.query));
route(E.assignReading, ({ run, input }) => run((c) => assignReading(c, input.params.articleId, input.body)));
route(E.readingStatus, ({ ctx, input }) => listReadingStatus(ctx, input.params.articleId, input.query));
route(E.cancelReading, ({ run, input }) => run((c) => cancelReading(c, input.params.assignmentId, input.body.reason)));
route(E.acknowledge, ({ run, input }) => run((c) => acknowledgeArticle(c, input.params.articleId, input.body)));
route(E.myReading, ({ ctx, input }) => myReading(ctx, input.query));
route(E.audiences, ({ ctx }) => readingAudiences(ctx));
route(E.createTask, ({ run, input }) => run((c) => createTaskFromChecklist(c, input.params.articleId, input.body)));
