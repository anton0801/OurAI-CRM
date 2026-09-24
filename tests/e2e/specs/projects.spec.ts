import { expect, test } from '@playwright/test';
import { readOwner } from '../support/helpers';

test.describe('projects', () => {
  test('create a project and open its workspace (F04 start, T021)', async ({ page }) => {
    const { workspaceId } = readOwner();
    await page.goto(`/w/${workspaceId}/projects`);
    await page.getByRole('button', { name: /New Project/ }).first().click();
    await page.waitForURL(/\/projects\/new/);
    await page.getByLabel(/^Name/).fill('Night Shift');
    await page.getByRole('combobox', { name: 'Direction' }).click();
    await page.getByRole('option', { name: 'AI Series' }).click();
    await page.getByLabel(/^Brief summary/).fill('Thriller series about a night-shift paramedic.');
    const create = page.getByRole('button', { name: 'Create Project' });
    // Double click must not create two projects (idempotency key reused).
    await create.dblclick();
    await page.waitForURL(/\/projects\/[0-9a-f-]{36}/);
    await expect(page.getByRole('heading', { name: 'Night Shift' })).toBeVisible();
    await page.goto(`/w/${workspaceId}/projects?q=Night%20Shift`);
    await expect(page.getByRole('link', { name: 'Night Shift' })).toHaveCount(1);
  });
});
