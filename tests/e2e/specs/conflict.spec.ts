import { expect, test, type Page } from '@playwright/test';
import { projectEndpoints } from '@castlane/api-contracts';
import { E2EApi } from '../support/api';
import { OWNER_STATE } from '../support/env';
import { readOwner } from '../support/helpers';
import { stageProject, uniqueSuffix } from '../support/stage';

/**
 * T162 — concurrent dirty form. The Owner has the same project open for editing in two browser
 * windows (two contexts, same account). Window A saves first; window B's save is rejected with 412
 * and shows the Conflict dialog while B's typed input stays in the form. Both options of the dialog
 * work: Keep Editing + Save merges B's change without writing back B's stale copy of A's change,
 * and Reload Latest Version shows the saved values (discarding B's unsaved input, as it says).
 */
const conflictTitle = 'This record changed while you were editing it.';

const openEditor = async (page: Page, projectId: string, name: string) => {
  await page.goto(`/w/${readOwner().workspaceId}/projects/${projectId}/edit`);
  await expect(page.getByRole('heading', { level: 1, name: `Edit ${name}` })).toBeVisible();
};

test('second save gets the conflict dialog and keeps the typed input (T162)', async ({ page: a, browser }) => {
  const owner = await E2EApi.owner();
  const name = `Harbor Lights ${uniqueSuffix()}`;
  const project = await stageProject(owner, { name });
  const params = { workspaceId: readOwner().workspaceId, projectId: project.id };

  const ctxB = await browser.newContext({ storageState: OWNER_STATE, viewport: { width: 1440, height: 900 } });
  const b = await ctxB.newPage();
  try {
    await openEditor(a, project.id, name);
    await openEditor(b, project.id, name);

    // B starts typing first (dirty form), A saves a different field meanwhile.
    const bDescription = 'Night harbour scenes; B wrote this while A was editing.';
    await b.getByLabel(/^Description/).fill(bDescription);
    const renamed = `${name} (renamed by A)`;
    await a.getByLabel(/^Name/).fill(renamed);
    await a.getByRole('button', { name: 'Save Changes' }).click();
    await a.waitForURL(new RegExp(`/projects/${project.id}$`));
    await expect(a.getByRole('heading', { level: 1, name: renamed })).toBeVisible();

    // B saves on the stale version → 412 → Conflict dialog; B's input is still there.
    const saveB = b.getByRole('button', { name: 'Save Changes' });
    const rejected = b.waitForResponse((r) => r.url().includes(`/projects/${project.id}`) && r.request().method() === 'PATCH');
    await saveB.click();
    expect((await rejected).status()).toBe(412);
    const dialog = b.getByRole('dialog', { name: conflictTitle });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Your input is still in the form.')).toBeVisible();
    await expect(b).toHaveURL(/\/edit$/);

    // Keep Editing: the dialog closes, focus returns to Save, nothing typed was lost.
    await dialog.getByRole('button', { name: 'Keep Editing' }).click();
    await expect(dialog).toBeHidden();
    await expect(saveB).toBeFocused();
    await expect(b.getByLabel(/^Description/)).toHaveValue(bDescription);

    // Saving again sends only B's own change: A's rename survives, B's description is kept.
    await saveB.click();
    await b.waitForURL(new RegExp(`/projects/${project.id}$`));
    const merged = await owner.call(projectEndpoints.get, { params });
    expect(merged.name).toBe(renamed);
    expect(merged.description).toBe(bDescription);

    // Second round: Reload Latest Version discards B's unsaved input and shows the saved values.
    await openEditor(a, project.id, renamed);
    await openEditor(b, project.id, renamed);
    await b.getByLabel(/^Audience/).fill('B: adults who binge short thrillers');
    await a.getByLabel(/^Audience/).fill('A: late-night commuters');
    await a.getByRole('button', { name: 'Save Changes' }).click();
    await a.waitForURL(new RegExp(`/projects/${project.id}$`));
    await b.getByRole('button', { name: 'Save Changes' }).click();
    await expect(dialog).toBeVisible();
    await expect(b.getByLabel(/^Audience/)).toHaveValue('B: adults who binge short thrillers');
    await dialog.getByRole('button', { name: 'Reload Latest Version' }).click();
    await expect(b.getByRole('heading', { level: 1, name: `Edit ${renamed}` })).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(b.getByLabel(/^Audience/)).toHaveValue('A: late-night commuters');
    await expect(b.getByLabel(/^Description/)).toHaveValue(bDescription);
    expect((await owner.call(projectEndpoints.get, { params })).audience).toBe('A: late-night commuters');
  } finally {
    await ctxB.close();
  }
});
