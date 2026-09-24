import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalOverflow, readOwner } from '../support/helpers';
import { stageReview } from '../support/stage';

/**
 * T167 — narrow screens and browser zoom: no horizontal page scroll on the main screens, and a
 * form validation error is visible without scrolling sideways.
 *
 * How 200 % zoom is emulated: browser zoom does not magnify a fixed layout — it makes each CSS
 * pixel two device pixels, so a 1440×900 window lays out a 720×450 CSS-pixel viewport at a device
 * pixel ratio of 2. Media queries, vw units and wrapping respond exactly as they do under real zoom.
 * A desktop (non-touch) context with viewport 720×450 and deviceScaleFactor 2 reproduces that.
 * `document.body.style.zoom` is not used: it scales the rendering without changing the layout
 * viewport, so media queries would still see 1440 px and the check would prove nothing.
 */
const SCREENS = [
  'overview',
  'my-work',
  'projects',
  'projects/new',
  'content',
  'tasks',
  'calendar',
  'accounts',
  'reviews',
  'analytics',
  'finance',
  'ofm',
  'knowledge',
  'team',
  'library',
  'settings/profile',
];

const ws = () => `/w/${readOwner().workspaceId}`;

// Detail screens with real records: a project, its content item with a submitted image version
// and the review waiting for the Owner (staged once through the API).
let details: string[] = [];
test.beforeAll(async () => {
  test.setTimeout(120_000);
  const s = await stageReview({ title: 'Narrow screen cover with a long title that has to wrap' });
  details = [`projects/${s.projectId}`, `content/${s.contentId}`, `content/${s.contentId}?tab=versions`, `reviews/${s.reviewId}`, `accounts/${s.accountId}`];
});

const visitAll = async (page: Page) => {
  for (const path of [...SCREENS, ...details]) {
    await page.goto(`${ws()}/${path}`);
    await expect(page.locator('main h1').first()).toBeVisible();
    await expect(page.getByRole('status', { name: /^Loading/ })).toHaveCount(0);
    await test.step(path, () => expectNoHorizontalOverflow(page));
  }
};

/** Submitting the empty New Project form shows the Name error next to the focused field, fully on screen. */
const expectVisibleValidationError = async (page: Page) => {
  await page.goto(`${ws()}/projects/new`);
  await page.getByRole('button', { name: 'Create Project' }).click();
  const error = page.getByText('Use 2–120 characters.');
  await expect(error).toBeVisible();
  await expect(page.getByLabel(/^Name/)).toBeFocused();
  await expect(page.getByLabel(/^Name/)).toHaveAttribute('aria-invalid', 'true');
  await expect(error).toBeInViewport();
  const box = (await error.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  await expectNoHorizontalOverflow(page);
};

test.describe('360 px phone', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('main screens fit 360 px and validation errors stay visible (T167)', async ({ page }) => {
    test.setTimeout(240_000);
    await visitAll(page);
    await expectVisibleValidationError(page);
  });
});

test.describe('200 % browser zoom of a 1440×900 window', () => {
  test.use({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false });

  test('main screens reflow at 200 % zoom and validation errors stay visible (T167)', async ({ page }) => {
    test.setTimeout(240_000);
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
    await visitAll(page);
    await expectVisibleValidationError(page);
  });
});
