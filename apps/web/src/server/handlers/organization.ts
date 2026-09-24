import { directionEndpoints as D, peopleEndpoints as P, projectEndpoints as E } from '@castlane/api-contracts';
import {
  addProjectMember,
  addProjectMilestone,
  archiveDirection,
  createDirection,
  createProject,
  endProjectMember,
  getProject,
  listDirections,
  listProjects,
  lookupPeople,
  pinProjectDecision,
  projectActivity,
  projectArchivePreview,
  transferProjectDirection,
  transitionProject,
  updateDirection,
  updateProject,
} from '@castlane/application';
import { route } from '../http/router';

route(P.lookup, ({ ctx, input }) => lookupPeople(ctx, input.query));

route(D.list, ({ ctx, input }) => listDirections(ctx, input.query));
route(D.create, ({ run, input }) => run((c) => createDirection(c, input.body)));
route(D.update, ({ run, input }) => run((c) => updateDirection(c, input.params.directionId, input.body)));
route(D.archive, ({ run, input }) => run((c) => archiveDirection(c, input.params.directionId, input.body.reason)));

route(E.list, ({ ctx, input }) => listProjects(ctx, input.query));
route(E.get, ({ ctx, input }) => getProject(ctx, input.params.projectId));
// Commands return the fresh read model built inside the same transaction.
route(E.create, ({ run, input }) => run(async (c) => getProject(c, await createProject(c, input.body))));
route(E.update, ({ run, input }) => run(async (c) => getProject(c, await updateProject(c, input.params.projectId, input.body))));
route(E.transition, ({ run, input }) => run(async (c) => getProject(c, await transitionProject(c, input.params.projectId, input.body))));
route(E.archivePreview, ({ ctx, input }) => projectArchivePreview(ctx, input.params.projectId));
route(E.transferDirection, ({ run, input }) => run(async (c) => getProject(c, await transferProjectDirection(c, input.params.projectId, input.body))));
route(E.addMember, ({ run, input }) => run((c) => addProjectMember(c, input.params.projectId, input.body)));
route(E.endMember, ({ run, input }) => run((c) => endProjectMember(c, input.params.projectId, input.params.projectMemberId, input.body.reason)));
route(E.addMilestone, ({ run, input }) => run((c) => addProjectMilestone(c, input.params.projectId, input.body)));
route(E.pinDecision, ({ run, input }) => run((c) => pinProjectDecision(c, input.params.projectId, input.body)));
route(E.activity, ({ ctx, input }) => projectActivity(ctx, input.params.projectId, input.query));
