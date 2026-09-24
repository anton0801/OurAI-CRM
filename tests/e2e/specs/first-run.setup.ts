import { expect, test } from '@playwright/test';
import { OWNER_STATE } from '../support/env';
import { readOwner, saveOwner, totpCode } from '../support/helpers';

/**
 * F01 / T003: first Owner sign-in after bootstrap — temporary password must be changed, MFA set up
 * with recovery codes, then the three workspace setup steps are saved on the server.
 */
test('first run of the Owner (F01, T003)', async ({ page }) => {
  const owner = readOwner();
  expect(owner.temporaryPassword).toBeTruthy();

  await page.goto('/');
  await expect(page).toHaveURL(/\/auth\/sign-in/);
  await page.getByLabel(/^Email/).fill(owner.email);
  await page.getByLabel(/^Password/).fill(owner.temporaryPassword!);
  await page.getByRole('button', { name: 'Sign In' }).click();

  // Temporary password → change before anything else.
  await page.waitForURL(/\/auth\/change-password/);
  await page.getByLabel(/^Current Password/).fill(owner.temporaryPassword!);
  await page.getByLabel(/^New Password/).fill(owner.password);
  await page.getByLabel(/^Confirm Password/).fill(owner.password);
  await page.getByRole('button', { name: 'Change Password' }).click();

  // MFA setup: confirm password, read the manual key, verify, keep recovery codes.
  await page.waitForURL(/\/auth\/mfa/);
  await page.getByLabel(/^Password/).fill(owner.password);
  await page.getByRole('button', { name: 'Continue' }).click();
  const secret = (await page.locator('code').first().innerText()).replace(/\s+/g, '');
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await page.getByLabel(/^Verification Code/).fill(await totpCode(secret));
  await page.getByRole('button', { name: 'Verify and Enable' }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  const codes = await page.locator('li, code').allInnerTexts();
  expect(codes.length).toBeGreaterThanOrEqual(10);
  saveOwner({ ...owner, temporaryPassword: null, totpSecret: secret });
  await page.getByRole('button', { name: /I Saved the Codes/ }).click();

  // Step 1: workspace — reload returns to the unfinished step.
  await page.waitForURL(/\/setup\/workspace/);
  await page.getByLabel(/^Name/).fill('Castlane Studio');
  await page.getByRole('button', { name: 'Save and Continue' }).click();
  await page.waitForURL(/\/setup\/directions/);
  await page.reload();
  await expect(page).toHaveURL(/\/setup\/directions/);

  // Step 2: the three default directions are offered and saved.
  await expect(page.getByLabel(/^Name/).first()).toHaveValue(/AI Series|AI Models|AI Influencers/);
  await page.getByRole('button', { name: 'Save and Continue' }).click();

  // Step 3: invitations can be skipped.
  await page.waitForURL(/\/setup\/team/);
  await page.getByRole('button', { name: 'Finish Setup' }).click();
  await page.waitForURL(/\/w\/[0-9a-f-]{36}\//);

  await page.context().storageState({ path: OWNER_STATE });
});
