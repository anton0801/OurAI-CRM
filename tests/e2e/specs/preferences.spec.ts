import { expect, test, type Locator, type Page } from '@playwright/test';
import { settingsEndpoints } from '@castlane/api-contracts';
import { E2EApi } from '../support/api';
import { OWNER_STATE } from '../support/env';
import { readOwner } from '../support/helpers';
import { stageProject, uniqueSuffix } from '../support/stage';

/**
 * T168 — appearance preferences. The theme is switched through Personal Settings (saved on the
 * server, applied without a reload and kept after one); status badges keep their text and a
 * readable contrast in both themes. With the reduced-motion preference drawers and dialogs appear
 * without animation and transitions are effectively instant.
 */
const ws = () => `/w/${readOwner().workspaceId}`;
let projectName = '';

test.beforeAll(async () => {
  projectName = `Glass Coast ${uniqueSuffix()}`;
  await stageProject(await E2EApi.owner(), { name: projectName });
});

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme ?? null);
/** Painted background of the app shell (the element holding the skip link and the layout). */
const canvas = (page: Page) =>
  page.evaluate(() => {
    const shell = document.querySelector('a[href="#main"]')?.parentElement;
    return shell ? getComputedStyle(shell).backgroundColor : null;
  });

/** WCAG contrast of an element's text against its own (opaque) background. */
const contrast = (el: Locator) =>
  el.evaluate((node) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const cs = getComputedStyle(node);
    const [a, b] = [lum(rgb(cs.color)), lum(rgb(cs.backgroundColor))];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });

const saveTheme = async (page: Page, label: 'System' | 'Light' | 'Dark') => {
  await page.goto(`${ws()}/settings/profile`);
  const group = page.getByRole('radiogroup', { name: 'Theme' });
  await group.getByRole('radio', { name: label }).click();
  await expect(group.getByRole('radio', { name: label })).toBeChecked();
  const saved = page.waitForResponse((r) => r.url().endsWith('/settings/me') && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByText('Profile saved')).toBeVisible();
};

/** The project's status badge in the Projects list: text (not only colour) and readable contrast. */
const expectReadableStatusBadge = async (page: Page) => {
  await page.goto(`${ws()}/projects?q=${encodeURIComponent(projectName)}`);
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: projectName }) });
  const badge = row.getByText('Active', { exact: true });
  await expect(badge).toBeVisible();
  // The coloured element is the badge itself (the text sits in a child span).
  const pill = badge.locator('xpath=..');
  expect(await contrast(pill)).toBeGreaterThanOrEqual(4.5);
};

test.describe('theme', () => {
  test.afterAll(async () => {
    // Leave the Owner on the default theme for the rest of the suite, even if the test failed.
    const owner = await E2EApi.owner();
    const params = { workspaceId: readOwner().workspaceId };
    const me = await owner.call(settingsEndpoints.me, { params });
    if (me.preferences.theme !== 'system') await owner.call(settingsEndpoints.updateMe, { params, body: { theme: 'system' } }, { ifMatch: me.rowVersion });
  });

  test('dark and light themes switch from Personal Settings; badges keep text and contrast (T168)', async ({ page }) => {
    await page.goto(`${ws()}/settings/profile`);
    const lightCanvas = await canvas(page);

    await saveTheme(page, 'Dark');
    await expect.poll(() => theme(page)).toBe('dark');
    await expect.poll(() => canvas(page)).toBe('rgb(17, 23, 21)');
    await page.reload();
    await expect.poll(() => theme(page)).toBe('dark');
    await expectReadableStatusBadge(page);
    await expect.poll(() => theme(page)).toBe('dark');

    await saveTheme(page, 'Light');
    await expect.poll(() => theme(page)).toBe('light');
    await expect.poll(() => canvas(page)).toBe('rgb(245, 247, 246)');
    expect(lightCanvas).toBe('rgb(245, 247, 246)');
    await expectReadableStatusBadge(page);

    // System follows the operating system again.
    await saveTheme(page, 'System');
    await expect.poll(() => theme(page)).toBeNull();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => canvas(page)).toBe('rgb(17, 23, 21)');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => canvas(page)).toBe('rgb(245, 247, 246)');
  });
});

test.describe('reduced motion', () => {
  const openDrawer = async (page: Page) => {
    await page.goto(`${ws()}/tasks`);
    await page.getByRole('button', { name: 'New Task' }).first().click();
    const drawer = page.getByRole('dialog', { name: 'New Task' });
    await expect(drawer).toBeVisible();
    return drawer;
  };
  const motion = (el: Locator) =>
    el.evaluate((n) => {
      const cs = getComputedStyle(n);
      const seconds = (v: string) => Math.max(...v.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) / 1000 : parseFloat(x))));
      return { animation: cs.animationName, animationSeconds: seconds(cs.animationDuration), transitionSeconds: seconds(cs.transitionDuration) };
    });

  test('drawers animate by default (baseline for the check below)', async ({ page }) => {
    const drawer = await openDrawer(page);
    const m = await motion(drawer);
    expect(m.animation).toBe('drawerIn');
    expect(m.animationSeconds).toBeGreaterThan(0.1);
  });

  test('with reduced motion, drawers, dialogs and the sidebar do not animate (T168)', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: OWNER_STATE, reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    try {
      const drawer = await openDrawer(page);
      const m = await motion(drawer);
      expect(m.animation).toBe('none');
      expect(m.animationSeconds).toBeLessThanOrEqual(0.001);
      expect(m.transitionSeconds).toBeLessThanOrEqual(0.001);
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();

      // Sidebar width transition and nav hover transitions are instant.
      const sidebar = page.locator('aside').first();
      expect((await motion(sidebar)).transitionSeconds).toBeLessThanOrEqual(0.001);
      expect((await motion(page.getByRole('navigation', { name: 'Main' }).getByRole('link').first())).transitionSeconds).toBeLessThanOrEqual(0.001);

      // A modal dialog: no entrance animation either.
      await page.goto(`${ws()}/team`);
      await page.getByRole('button', { name: 'Invite' }).first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      expect((await motion(dialog)).animation).toBe('none');
    } finally {
      await ctx.close();
    }
  });
});
