import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, readOwner } from '../support/helpers';

/** T167: no horizontal page scroll at 390 px; navigation reachable on a phone. */
test('primary screens fit a phone viewport', async ({ page }) => {
  const { workspaceId } = readOwner();
  for (const path of ['projects', 'projects/new']) {
    await page.goto(`/w/${workspaceId}/${path}`);
    await expect(page.locator('main')).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});
