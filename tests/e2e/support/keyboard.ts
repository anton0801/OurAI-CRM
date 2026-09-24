import { expect, type Locator, type Page } from '@playwright/test';

const isFocused = (target: Locator) => target.evaluate((el) => el === document.activeElement).catch(() => false);

/**
 * Press Tab (or Shift+Tab with `back`) until `target` has focus — proves the control is reachable
 * in the tab order. When it is not reached within `max` presses the other direction is tried (after
 * a client-side navigation the tab start stays where the previous page's control was).
 */
export const tabTo = async (page: Page, target: Locator, { back = false, max = 60 }: { back?: boolean; max?: number } = {}) => {
  await target.waitFor();
  for (const dir of back ? ['Shift+Tab', 'Tab'] : ['Tab', 'Shift+Tab'])
    for (let i = 0; i < max && !(await isFocused(target)); i++) await page.keyboard.press(dir);
  await expect(target).toBeFocused({ timeout: 1000 });
};

/** In an open menu, move with ArrowDown until the item has focus (Radix menus focus items). */
export const arrowTo = async (page: Page, item: Locator, max = 20) => {
  await item.waitFor();
  for (let i = 0; i < max && !(await isFocused(item)); i++) await page.keyboard.press('ArrowDown');
  await expect(item).toBeFocused({ timeout: 1000 });
};

/** Tab and Shift+Tab never leave an open modal dialog (focus trap). */
export const expectFocusTrapped = async (page: Page, dialog: Locator, presses = 14) => {
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press(i < presses / 2 ? 'Tab' : 'Shift+Tab');
    expect(await dialog.evaluate((d) => d.contains(document.activeElement)), `focus left the dialog after ${i + 1} presses`).toBe(true);
  }
};

/** After a full page load the first Tab reaches the shell's skip link; Enter moves the tab start into <main>. */
export const skipToContent = async (page: Page) => {
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
};

/** Type a date-time into a focused datetime-local input segment by segment (en-US: mm dd yyyy hh mm AM/PM). */
export const typeDateTime = async (page: Page, at: Date) => {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const h = at.getUTCHours();
  await page.keyboard.type(`${p2(at.getUTCMonth() + 1)}${p2(at.getUTCDate())}${at.getUTCFullYear()}`);
  await page.keyboard.press('Tab');
  await page.keyboard.type(`${p2(h % 12 || 12)}${p2(at.getUTCMinutes())}`);
  await page.keyboard.type(h < 12 ? 'A' : 'P');
};
