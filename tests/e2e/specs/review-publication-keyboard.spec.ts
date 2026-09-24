import { expect, test } from '@playwright/test';
import { readOwner } from '../support/helpers';
import { arrowTo, expectFocusTrapped, skipToContent, tabTo, typeDateTime } from '../support/keyboard';
import { stageReview, type ReviewStage } from '../support/stage';

/**
 * T166 — keyboard-only Review → Publication. A Creator submitted version 1 of an image (a real PNG
 * through the upload pipeline) with the Owner as reviewer. The Owner then works with the keyboard
 * alone (Tab / Shift+Tab / Enter / Space / Escape / arrows — no mouse): opens the review from the
 * queue, approves the exact version, plans the placement on the content's account and confirms it
 * as published with the post URL. Dialogs trap focus, Escape closes them, and focus returns to the
 * control that opened them (or to the decision / page title when that control is gone).
 */
let s: ReviewStage;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  s = await stageReview({ title: 'Cover: the address that burned down' });
});

test('review, approve and publish with the keyboard only (T166)', async ({ page }) => {
  test.setTimeout(180_000);
  const ws = `/w/${readOwner().workspaceId}`;

  // Review queue → the review, by keyboard.
  await page.goto(`${ws}/reviews`);
  await expect(page.getByRole('heading', { level: 1, name: 'Review Queue' })).toBeVisible();
  await skipToContent(page);
  const reviewLink = page.getByRole('table', { name: 'Review queue' }).getByRole('link', { name: s.title });
  await tabTo(page, reviewLink);
  await page.keyboard.press('Enter');
  await page.waitForURL(new RegExp(`/reviews/${s.reviewId}`));
  await expect(page.getByRole('heading', { level: 1, name: `Review: ${s.title}` })).toBeVisible();

  // "D" jumps to the decision; the next Tab stop is reachable approval.
  const decision = page.getByRole('heading', { level: 2, name: /^Decision:/ });
  await expect(decision).toHaveText('Decision: Pending');
  await page.keyboard.press('d');
  await expect(decision).toBeFocused();
  const approve = page.getByRole('button', { name: 'Approve Version 1' });
  await tabTo(page, approve);

  // Enter opens the dialog; focus is inside and trapped; Escape closes it and focus returns.
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Approve version 1?' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await expectFocusTrapped(page, dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(approve).toBeFocused();

  // Space opens it again; a typed note makes Escape ask first — keeping edits returns to the note.
  await page.keyboard.press('Space');
  await expect(dialog).toBeVisible();
  const note = dialog.getByRole('textbox', { name: 'Decision note' });
  await tabTo(page, note);
  await page.keyboard.type('Sharp, on brief. Approved from the keyboard.');
  await page.keyboard.press('Escape');
  const guard = page.getByRole('dialog', { name: 'You have unsaved changes.' });
  await expect(guard).toBeVisible();
  await expect.poll(() => guard.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(guard).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(note).toBeFocused();
  await expect(note).toHaveValue('Sharp, on brief. Approved from the keyboard.');

  // Approve: the decision is recorded and focus lands on the decision status, not on <body>.
  await tabTo(page, dialog.getByRole('button', { name: 'Approve Version 1' }));
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(decision).toHaveText('Decision: Approved');
  await expect(decision).toBeFocused();

  // Content → "More content actions" → Add Publication.
  const openContent = page.getByRole('button', { name: 'Open Content' });
  await tabTo(page, openContent, { back: true });
  await page.keyboard.press('Enter');
  await page.waitForURL(new RegExp(`/content/${s.contentId}`));
  await expect(page.getByRole('heading', { level: 1, name: s.title })).toBeVisible();
  const more = page.getByRole('button', { name: 'More content actions' });
  await tabTo(page, more);
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'More content actions' });
  await expect(menu).toBeVisible();
  await arrowTo(page, menu.getByRole('menuitem', { name: 'Add Publication' }));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/publications\/new\?/);

  // The form arrives with the content, its planned account and the approved version pinned.
  await expect(page.getByRole('heading', { level: 1, name: 'New Publication' })).toBeVisible();
  const account = page.getByRole('combobox', { name: 'Account' });
  await expect(account).toContainText(s.accountHandle);
  await expect(page.getByRole('combobox', { name: 'Content' })).toContainText(s.title);
  await expect(page.getByRole('combobox', { name: 'Approved version' })).toContainText('Version 1 · Approved');
  await skipToContent(page);
  // A picker opens and closes from the keyboard and gives focus back to its field.
  await tabTo(page, account);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(account).toBeFocused();
  const when = new Date(Date.now() + 2 * 86_400_000);
  when.setUTCHours(10, 30, 0, 0);
  await tabTo(page, page.getByLabel('Scheduled at'));
  await typeDateTime(page, when);
  await tabTo(page, page.getByRole('button', { name: 'Schedule', exact: true }));
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/publications\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: s.title })).toBeVisible();
  await expect(page.locator('main header').getByText('Scheduled', { exact: true })).toBeVisible();

  // Mark Published: trapped dialog, URL typed, confirmed; focus goes to the page title because
  // the Mark Published action is no longer offered.
  const markPublished = page.getByRole('button', { name: 'Mark Published' });
  await tabTo(page, markPublished);
  await page.keyboard.press('Enter');
  const publish = page.getByRole('dialog', { name: 'Mark Published' });
  await expect(publish).toBeVisible();
  await expectFocusTrapped(page, publish);
  await expect(publish.getByLabel('Actual published at')).not.toHaveValue('');
  const postUrl = `https://www.tiktok.com/@${s.accountHandle}/video/7400000000000000123`;
  await tabTo(page, publish.getByRole('textbox', { name: 'External post URL' }));
  await page.keyboard.type(postUrl);
  await tabTo(page, publish.getByRole('button', { name: 'Mark Published' }));
  await page.keyboard.press('Enter');
  await expect(publish).toBeHidden();
  await expect(page.locator('main header').getByText('Published', { exact: true })).toBeVisible();
  await expect(markPublished).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: s.title })).toBeFocused();
  await expect(page.getByRole('main').getByText(postUrl)).toBeVisible();
});
