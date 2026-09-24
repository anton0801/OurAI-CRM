import { readFileSync, writeFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { OWNER_FILE } from './env';

export interface OwnerCredentials {
  email: string;
  temporaryPassword: string | null;
  password: string;
  workspaceId: string;
  totpSecret?: string;
}

export const readOwner = (): OwnerCredentials => JSON.parse(readFileSync(OWNER_FILE, 'utf8')) as OwnerCredentials;
export const saveOwner = (o: OwnerCredentials) => writeFileSync(OWNER_FILE, JSON.stringify(o, null, 2));

/** A TOTP code for the next step (waits for a fresh window so a code is never reused — replay is rejected). */
export const totpCode = async (secret: string, previous?: string) => {
  const totp = new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 });
  let code = totp.generate();
  while (code === previous) {
    await new Promise((r) => setTimeout(r, 1000));
    code = totp.generate();
  }
  return code;
};

export const signIn = async (page: Page, email: string, password: string, totpSecret: string) => {
  await page.goto('/auth/sign-in');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.waitForURL(/\/auth\/mfa/);
  await page.getByLabel(/^Verification Code/).fill(await totpCode(totpSecret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/auth/'));
};

/** No horizontal page scroll at the current viewport (T167). */
export const expectNoHorizontalOverflow = async (page: Page) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
};
