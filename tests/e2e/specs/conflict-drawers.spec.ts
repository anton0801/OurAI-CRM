import { expect, test, type Locator, type Page } from '@playwright/test';
import { goalEndpoints, taskEndpoints } from '@castlane/api-contracts';
import { E2EApi } from '../support/api';
import { OWNER_STATE } from '../support/env';
import { readOwner } from '../support/helpers';
import { ownerMembershipId } from '../support/members';
import { stageProject, uniqueSuffix } from '../support/stage';

/**
 * T162 in edit drawers. The drawer keeps the version it opened with: a live update that refreshes
 * the record in the background neither wipes what the member is typing nor moves If-Match, so their
 * save is rejected with 412 and the Conflict dialog opens with the input still in the form. Keep
 * Editing + Save sends only the member's own changes (the other editor's change survives); Reload
 * Latest Version shows the saved values.
 */
const conflictTitle = 'This record changed while you were editing it.';
const workspaceId = () => readOwner().workspaceId;

/** The drawer panel, found by CSS so it stays reachable while the Conflict dialog hides it from the accessibility tree. */
const drawerWith = (page: Page, text: string) => page.locator('[role="dialog"]').filter({ hasText: text });

const isoDate = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

test('task drawer: live update keeps the typing, second save gets the conflict dialog (T162)', async ({ page: a, browser }) => {
  const owner = await E2EApi.owner();
  const suffix = uniqueSuffix();
  const project = await stageProject(owner, { name: `Tide Tables ${suffix}` });
  const title = `Storyboard the pier chase ${suffix}`;
  const task = await owner.call(taskEndpoints.create, {
    params: { workspaceId: workspaceId() },
    body: { title, projectId: project.id, description: 'Rough cut of the chase.', status: 'backlog', priority: 'normal' },
  });
  const params = { workspaceId: workspaceId(), taskId: task.id };
  const taskUrl = `/w/${workspaceId()}/tasks/${task.id}`;
  const openDrawer = async (page: Page, heading: string) => {
    await page.goto(taskUrl);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Edit Task' });
    await expect(drawer).toBeVisible();
    return drawerWith(page, 'Edit Task');
  };

  const ctxB = await browser.newContext({ storageState: OWNER_STATE, viewport: { width: 1440, height: 900 } });
  const b = await ctxB.newPage();
  try {
    const drawerB = await openDrawer(b, title);
    const descriptionB = drawerB.getByLabel(/^Description/);
    const bDescription = 'B: add the lighthouse cutaways before the chase.';
    await descriptionB.fill(bDescription);

    // A renames the task in its own window while B is still typing.
    const drawerA = await openDrawer(a, title);
    const renamed = `${title} (renamed by A)`;
    await drawerA.getByLabel(/^Title/).fill(renamed);
    await drawerA.getByRole('button', { name: 'Save Changes' }).click();
    await expect(a.getByRole('heading', { level: 1, name: renamed })).toBeVisible();

    // B's page receives A's change as a live update (the drawer's subtitle shows the new title) …
    await expect(drawerB).toContainText(renamed);
    // … and B's form is untouched: no reset to the refreshed record, the typing is still there.
    await expect(descriptionB).toHaveValue(bDescription);
    await expect(drawerB.getByLabel(/^Title/)).toHaveValue(title);

    // B saves on the version the drawer opened with → 412 → Conflict dialog, input kept.
    const saveB = drawerB.getByRole('button', { name: 'Save Changes' });
    const rejected = b.waitForResponse((r) => r.url().endsWith(`/tasks/${task.id}`) && r.request().method() === 'PATCH');
    await saveB.click();
    expect((await rejected).status()).toBe(412);
    const dialog = b.getByRole('dialog', { name: conflictTitle });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Your input is still in the form.')).toBeVisible();
    await expect(descriptionB).toHaveValue(bDescription);

    // Keep Editing: back in the drawer with the input; saving sends only B's change.
    await dialog.getByRole('button', { name: 'Keep Editing' }).click();
    await expect(dialog).toBeHidden();
    await expect(saveB).toBeFocused();
    await expect(descriptionB).toHaveValue(bDescription);
    const accepted = b.waitForResponse((r) => r.url().endsWith(`/tasks/${task.id}`) && r.request().method() === 'PATCH');
    await saveB.click();
    expect((await accepted).status()).toBe(200);
    await expect(b.getByRole('dialog', { name: 'Edit Task' })).toBeHidden();
    const merged = await owner.call(taskEndpoints.get, { params });
    expect(merged.title).toBe(renamed);
    expect(merged.description).toBe(bDescription);

    // Second round: Reload Latest Version discards B's unsaved input and shows the saved values.
    const drawerB2 = await openDrawer(b, renamed);
    await drawerB2.getByLabel(/^Description/).fill('B: unsaved second thought.');
    const retitled = `${title} (final)`;
    const current = await owner.call(taskEndpoints.get, { params });
    await owner.call(taskEndpoints.update, { params, body: { title: retitled, description: 'A: saved while B was typing.' } }, { ifMatch: current.rowVersion });
    await expect(drawerB2).toContainText(retitled);
    await expect(drawerB2.getByLabel(/^Description/)).toHaveValue('B: unsaved second thought.');
    await drawerB2.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Reload Latest Version' }).click();
    await expect(dialog).toBeHidden();
    await expect(drawerB2.getByLabel(/^Description/)).toHaveValue('A: saved while B was typing.');
    await expect(drawerB2.getByLabel(/^Title/)).toHaveValue(retitled);
  } finally {
    await ctxB.close();
  }
});

test('goal drawer: live update keeps the typed target, second save gets the conflict dialog (T162)', async ({ page }) => {
  const owner = await E2EApi.owner();
  const metrics = await owner.call(goalEndpoints.metricOptions, { params: { workspaceId: workspaceId() } });
  const metric = metrics.find((m) => !m.rate && !m.measuresChange) ?? metrics[0]!;
  const name = `Winter reach ${uniqueSuffix()}`;
  // The period starts later, so changing the target needs no revision reason.
  const goal = await owner.call(goalEndpoints.create, {
    params: { workspaceId: workspaceId() },
    body: {
      name,
      ownerMembershipId: await ownerMembershipId(),
      scopeType: 'workspace',
      scopeId: null,
      metricId: metric.id,
      targetType: 'absolute',
      targetValue: '1000',
      periodStart: isoDate(30),
      periodEnd: isoDate(60),
      direction: 'increase',
    },
  });
  const params = { workspaceId: workspaceId(), goalId: goal.id };

  await page.goto(`/w/${workspaceId()}/goals/${goal.id}?edit=1`);
  await expect(page.getByRole('dialog', { name: `Edit ${name}` })).toBeVisible();
  const drawer = drawerWith(page, 'Target type');
  const target: Locator = drawer.getByLabel(/^Target(?! type)/);
  await target.fill('2500');

  // Another editor renames the goal meanwhile; the live update refreshes the record behind the drawer.
  const renamed = `${name} (renamed elsewhere)`;
  await owner.call(goalEndpoints.update, { params, body: { name: renamed } }, { ifMatch: goal.rowVersion });
  await expect(page.getByRole('dialog', { name: `Edit ${renamed}` })).toBeVisible();
  await expect(target).toHaveValue('2500');
  await expect(drawer.getByLabel(/^Name/)).toHaveValue(name);

  // The save still carries the version the drawer opened with → 412 → Conflict dialog, input kept.
  const save = drawer.getByRole('button', { name: 'Save Changes' });
  const rejected = page.waitForResponse((r) => r.url().endsWith(`/goals/${goal.id}`) && r.request().method() === 'PATCH');
  await save.click();
  expect((await rejected).status()).toBe(412);
  const dialog = page.getByRole('dialog', { name: conflictTitle });
  await expect(dialog).toBeVisible();
  await expect(target).toHaveValue('2500');

  // Keep Editing + Save: only the target is sent, so the rename made elsewhere survives.
  await dialog.getByRole('button', { name: 'Keep Editing' }).click();
  await expect(dialog).toBeHidden();
  await expect(save).toBeFocused();
  const accepted = page.waitForResponse((r) => r.url().endsWith(`/goals/${goal.id}`) && r.request().method() === 'PATCH');
  await save.click();
  expect((await accepted).status()).toBe(200);
  await expect(page.getByRole('dialog', { name: `Edit ${renamed}` })).toBeHidden();
  const merged = await owner.call(goalEndpoints.get, { params });
  expect(merged.name).toBe(renamed);
  expect(Number(merged.targetValue)).toBe(2500);
});
