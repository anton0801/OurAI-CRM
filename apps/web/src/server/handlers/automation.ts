import { automationEndpoints as E } from '@castlane/api-contracts';
import {
  archiveAutomationRule,
  automationCatalog,
  automationDryRunSamples,
  createAutomationRule,
  disableAutomationRule,
  dryRunAutomationRule,
  duplicateAutomationRule,
  enableAutomationRule,
  getAutomationRule,
  getAutomationRun,
  listAutomationRules,
  listAutomationRuns,
  listAutomationTemplates,
  requirePermission,
  retryAutomationRun,
  updateAutomationRule,
  validateRuleDraft,
} from '@castlane/application';
import { route } from '../http/router';

// Static paths are registered before /automations/{ruleId} so they are never read as ids.
route(E.catalog, async ({ ctx }) => automationCatalog(ctx));
route(E.templates, async ({ ctx }) => listAutomationTemplates(ctx));
route(E.validate, async ({ ctx, input }) => {
  requirePermission(ctx, 'automations.read');
  const b = input.body;
  const r = await validateRuleDraft(ctx, { name: b.name, ownerMembershipId: b.ownerMembershipId, scopeType: b.scopeType, scopeId: b.scopeType === 'workspace' ? null : (b.scopeId ?? null), config: b.config }, { forEnable: true });
  return { ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings };
});
route(E.list, ({ ctx, input }) => listAutomationRules(ctx, input.query));
route(E.get, ({ ctx, input }) => getAutomationRule(ctx, input.params.ruleId));
route(E.create, ({ run, input }) =>
  run(async (c) => getAutomationRule(c, await createAutomationRule(c, { ...input.body, scopeId: input.body.scopeType === 'workspace' ? null : (input.body.scopeId ?? null) }))),
);
route(E.update, ({ run, input }) => run(async (c) => getAutomationRule(c, await updateAutomationRule(c, input.params.ruleId, input.body))));
route(E.enable, ({ run, input }) => run(async (c) => getAutomationRule(c, await enableAutomationRule(c, input.params.ruleId, input.body))));
route(E.disable, ({ run, input }) => run(async (c) => getAutomationRule(c, await disableAutomationRule(c, input.params.ruleId, input.body))));
route(E.duplicate, ({ run, input }) => run(async (c) => getAutomationRule(c, await duplicateAutomationRule(c, input.params.ruleId, input.body))));
route(E.archive, ({ run, input }) => run(async (c) => getAutomationRule(c, await archiveAutomationRule(c, input.params.ruleId, input.body))));
route(E.dryRunSamples, ({ ctx, input }) => automationDryRunSamples(ctx, input.params.ruleId, input.query));
route(E.dryRun, ({ ctx, input }) => dryRunAutomationRule(ctx, input.params.ruleId, input.body));
route(E.runs, ({ ctx, input }) => listAutomationRuns(ctx, input.params.ruleId, input.query));
route(E.run, ({ ctx, input }) => getAutomationRun(ctx, input.params.runId));
route(E.retryRun, ({ run, input }) => run(async (c) => getAutomationRun(c, await retryAutomationRun(c, input.params.runId, input.body))));
