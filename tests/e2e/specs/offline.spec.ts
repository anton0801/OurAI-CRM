import { expect, test, type Page } from '@playwright/test';
import { projectEndpoints } from '@castlane/api-contracts';
import { E2EApi } from '../support/api';
import { readOwner } from '../support/helpers';
import { stageProject, uniqueSuffix } from '../support/stage';

/**
 * T165 — offline. When the browser loses the connection the app says so, a save fails honestly
 * with the typed input kept, and nothing is queued to be sent behind the member's back once the
 * connection returns: the change is saved only when the member saves again.
 */
const OFFLINE_ERROR = 'You appear to be offline. The change was not saved.';

/** Collect PATCH/POST requests the page sends from now on. */
const writes = (page: Page) => {
  const seen: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/api/v1/')) seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  return seen;
};

test('saving while offline fails honestly and is not replayed later (T165)', async ({ page, context }) => {
  const owner = await E2EApi.owner();
  const name = `Low Tide ${uniqueSuffix()}`;
  const project = await stageProject(owner, { name });
  const params = { workspaceId: readOwner().workspaceId, projectId: project.id };

  await page.goto(`/w/${params.workspaceId}/projects/${project.id}/edit`);
  await expect(page.getByRole('heading', { level: 1, name: `Edit ${name}` })).toBeVisible();
  const renamed = `${name} offline edit`;
  await page.getByLabel(/^Name/).fill(renamed);

  await context.setOffline(true);
  await expect(page.getByText('You are offline. Changes are not being saved.')).toBeVisible();
  const save = page.getByRole('button', { name: 'Save Changes' });
  await save.click();
  await expect(page.getByRole('alert').filter({ hasText: OFFLINE_ERROR })).toBeVisible();
  // Not stuck "saving", still on the form, input kept.
  await expect(save).toBeEnabled();
  await expect(page).toHaveURL(/\/edit$/);
  await expect(page.getByLabel(/^Name/)).toHaveValue(renamed);

  // Back online: nothing is sent on its own and the record is unchanged.
  const sent = writes(page);
  await context.setOffline(false);
  await expect(page.getByText('You are offline. Changes are not being saved.')).toBeHidden();
  await page.waitForLoadState('networkidle');
  expect(sent).toEqual([]);
  expect((await owner.call(projectEndpoints.get, { params })).name).toBe(name);

  // Saving again is an explicit action and succeeds.
  await save.click();
  await page.waitForURL(new RegExp(`/projects/${project.id}$`));
  await expect(page.getByRole('heading', { level: 1, name: renamed })).toBeVisible();
  expect(sent).toEqual([`PATCH /api/v1/workspaces/${params.workspaceId}/projects/${project.id}`]);
});

test('a drawer form keeps its input and explains the failed save while offline (T165)', async ({ page, context }) => {
  const owner = await E2EApi.owner();
  const project = await stageProject(owner, { name: `Tide Tables ${uniqueSuffix()}` });
  await page.goto(`/w/${readOwner().workspaceId}/tasks`);
  await page.getByRole('button', { name: 'New Task' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'New Task' });
  await expect(drawer).toBeVisible();
  const title = `Check the tide table ${uniqueSuffix()}`;
  await drawer.getByLabel(/^Title/).fill(title);
  await drawer.getByRole('combobox', { name: /^Project/ }).click();
  await page.getByRole('textbox', { name: 'Search options' }).fill(project.name);
  await page.getByRole('option', { name: project.name }).click();

  await context.setOffline(true);
  await drawer.getByRole('button', { name: 'Create Task' }).click();
  await expect(drawer.getByText(OFFLINE_ERROR)).toBeVisible();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel(/^Title/)).toHaveValue(title);

  const sent = writes(page);
  await context.setOffline(false);
  await page.waitForLoadState('networkidle');
  expect(sent).toEqual([]);
});
