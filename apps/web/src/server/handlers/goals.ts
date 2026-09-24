import { goalEndpoints as E } from '@castlane/api-contracts';
import { archiveGoal, checkInGoal, closeGoal, createGoal, getGoal, goalMetricOptions, listGoals, updateGoal } from '@castlane/application';
import { route } from '../http/router';

// Static path first so it is never read as a goal id.
route(E.metricOptions, async ({ ctx }) => goalMetricOptions(ctx));
route(E.list, ({ ctx, input }) => listGoals(ctx, input.query));
route(E.get, ({ ctx, input }) => getGoal(ctx, input.params.goalId));
route(E.create, ({ run, input }) => run(async (c) => getGoal(c, await createGoal(c, input.body))));
route(E.update, ({ run, input }) => run(async (c) => getGoal(c, await updateGoal(c, input.params.goalId, input.body))));
route(E.checkIn, ({ run, input }) => run(async (c) => getGoal(c, await checkInGoal(c, input.params.goalId, input.body))));
route(E.close, ({ run, input }) => run(async (c) => getGoal(c, await closeGoal(c, input.params.goalId, input.body))));
route(E.archive, ({ run, input }) => run(async (c) => getGoal(c, await archiveGoal(c, input.params.goalId, input.body))));
