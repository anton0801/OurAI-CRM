import { expect, test, type Page } from '@playwright/test';
import { readOwner } from '../support/helpers';

/**
 * T169 — empty production workspace. Right after the first run the workspace holds only the Owner
 * and the setup directions. Every section must explain what will appear there and offer a next
 * step that really works; KPIs say "No data" / "Not applicable" instead of inventing values, and
 * no chart is drawn without source records (a chart with values renders a <figure>, an empty one
 * renders the "No data recorded" text).
 *
 * Runs in its own Playwright project ("empty") before every spec that creates data.
 */

const ws = () => `/w/${readOwner().workspaceId}`;

/** Page rendered and every loading skeleton gone. */
const open = async (page: Page, path: string) => {
  await page.goto(`${ws()}${path}`);
  await expect(page.locator('main')).toBeVisible();
  await expect(page.getByRole('status', { name: /^Loading/ })).toHaveCount(0);
};

const main = (page: Page) => page.locator('main');

/** No chart with values anywhere in the page body. */
const expectNoCharts = async (page: Page) => {
  await expect(main(page).locator('figure')).toHaveCount(0);
  await expect(main(page).getByRole('button', { name: 'Show table' })).toHaveCount(0);
};

/** An empty state's heading (h2). */
const emptyState = (page: Page, title: string | RegExp) => main(page).getByRole('heading', { level: 2, name: title });

test.describe('empty workspace (T169)', () => {
  test('Overview offers the first steps instead of numbers', async ({ page }) => {
    await open(page, '/overview');
    await expect(emptyState(page, 'Get started')).toBeVisible();
    await expect(main(page).getByText('Nothing here is sample data.')).toBeVisible();
    for (const step of ['Step 1: Start a Project (to do)', 'Step 2: Add an Account (to do)', 'Step 3: Create a Task (to do)'])
      await expect(main(page).getByRole('listitem').filter({ hasText: step })).toBeVisible();
    await expectNoCharts(page);
    await main(page).getByRole('button', { name: 'Start a Project' }).click();
    await page.waitForURL(/\/projects\/new$/);
    await expect(page.getByRole('heading', { level: 1, name: 'New Project' })).toBeVisible();
  });

  test('Projects, Content and Accounts explain themselves and open their create forms', async ({ page }) => {
    await open(page, '/projects');
    await expect(emptyState(page, 'Start your first project')).toBeVisible();
    await expect(main(page).getByText('No projects yet. Create a project to organize its team, accounts, and content.')).toBeVisible();
    await main(page).getByRole('button', { name: 'New Project' }).last().click();
    await page.waitForURL(/\/projects\/new$/);

    await open(page, '/content');
    await expect(emptyState(page, 'No content yet')).toBeVisible();
    await expect(main(page).getByText(/Create a content item to plan its brief/)).toBeVisible();
    await main(page).getByRole('button', { name: 'New Content' }).last().click();
    await page.waitForURL(/\/content\/new$/);
    await expect(page.getByRole('heading', { level: 1, name: 'New Content' })).toBeVisible();

    await open(page, '/accounts');
    await expect(emptyState(page, 'No accounts yet')).toBeVisible();
    await expect(main(page).getByText(/Add an account link to start planning publications/)).toBeVisible();
    await main(page).getByRole('button', { name: 'Add Account' }).last().click();
    await page.waitForURL(/\/accounts\/new$/);
  });

  test('Tasks: the empty state opens the New Task drawer', async ({ page }) => {
    await open(page, '/tasks');
    await expect(emptyState(page, 'No open tasks')).toBeVisible();
    await expect(main(page).getByText('Create a task, or apply a template to plan the work.')).toBeVisible();
    const cta = main(page).getByRole('button', { name: 'New Task' }).last();
    await cta.click();
    const drawer = page.getByRole('dialog', { name: 'New Task' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Nothing is created until you save.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(cta).toBeFocused();
  });

  test('Publications: the calendar has no events and offers Create Publication', async ({ page }) => {
    await open(page, '/calendar');
    const cells = page.getByRole('grid', { name: 'Calendar' }).getByRole('gridcell');
    await expect(cells.first()).toBeVisible();
    const labels = await cells.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
    expect(labels.length).toBeGreaterThanOrEqual(28);
    for (const l of labels) expect(l).toMatch(/: 0 event\(s\)$/);
    await page.getByRole('group', { name: 'Calendar view' }).getByRole('button', { name: 'Agenda' }).click();
    await expect(emptyState(page, 'Nothing planned in this period')).toBeVisible();
    await expect(main(page).getByText('Scheduled publications, task deadlines, milestones and shifts appear here.')).toBeVisible();
    await page.getByRole('button', { name: 'Create Publication' }).click();
    await page.waitForURL(/\/publications\/new/);
    await expect(page.getByRole('heading', { level: 1, name: 'New Publication' })).toBeVisible();
  });

  test('Analytics dashboards show "No data" with a next step on every tab, never a chart', async ({ page }) => {
    await open(page, '/analytics');
    const ctas: Record<string, string[]> = {
      Production: ['Open Content Pipeline'],
      Accounts: ['Add Metrics', 'Open Metrics Inbox'],
      Content: ['Add Metrics', 'Open Metrics Inbox'],
      OFM: ['Open OFM'],
      Team: ['Open Tasks'],
      Finance: ['Add Entry'],
    };
    for (const [tab, buttons] of Object.entries(ctas)) {
      await page.getByRole('tab', { name: tab }).click();
      const panel = page.getByRole('tabpanel', { name: tab });
      await expect(panel).toBeVisible();
      await expect(page.getByRole('status', { name: /^Loading/ })).toHaveCount(0);
      await expect(panel.getByRole('heading', { level: 2, name: 'No data recorded for this period.' })).toBeVisible();
      await expect(panel.getByText(/Nothing is estimated or filled in/)).toBeVisible();
      // No KPI tile (each has a formula button) and no chart.
      await expect(panel.getByRole('button', { name: /^How .* is calculated$/ })).toHaveCount(0);
      await expectNoCharts(page);
      for (const b of buttons) await expect(panel.getByRole('button', { name: b })).toBeVisible();
    }
    await page.getByRole('tab', { name: 'Production' }).click();
    await page.getByRole('tabpanel', { name: 'Production' }).getByRole('button', { name: 'Open Content Pipeline' }).click();
    await page.waitForURL(/\/content$/);
    await open(page, '/analytics?tab=ofm');
    await page.getByRole('tabpanel', { name: 'OFM' }).getByRole('button', { name: 'Open OFM' }).click();
    await page.waitForURL(/\/ofm$/);
  });

  test('Finance overview: no invented rates, empty ledger with Add Entry', async ({ page }) => {
    await open(page, '/finance');
    await expectNoCharts(page);
    const accrual = page.getByRole('tabpanel', { name: 'Accrual' });
    await expect(accrual.getByText('Operating Margin')).toBeVisible();
    await expect(accrual.getByText('This rate cannot be calculated from the available data.').first()).toBeVisible();
    await expect(accrual.getByText('No costs in this period')).toBeVisible();
    await expect(accrual.getByText('No posted records for this period.')).toBeVisible();
    await expect(emptyState(page, 'No entries in this period')).toBeVisible();
    await expect(main(page).getByText(/Drafts stay out of totals until they are posted/)).toBeVisible();
    await main(page).getByRole('button', { name: 'Add Entry' }).last().click();
    await page.waitForURL(/\/finance\/entries\/new$/);
  });

  test('OFM: no models, and KPIs without data say so', async ({ page }) => {
    await open(page, '/ofm');
    await expectNoCharts(page);
    await expect(emptyState(page, 'No OFM models in your scope')).toBeVisible();
    await expect(main(page).getByText(/Enable OFM on a Model or Influencer project/)).toBeVisible();
    await expect(main(page).getByText(/Net Shift Hours\s*No data recorded/)).toBeVisible();
    await expect(main(page).getByText(/Handover Completion\s*Not applicable/)).toBeVisible();
    await expect(main(page).getByRole('link', { name: /Quality Score\s*No Score/ })).toBeVisible();
    await expect(main(page).getByText('Nothing needs attention in your scope right now.')).toBeVisible();
    // The CTA lists the projects that can carry OFM (models and influencers).
    await main(page).getByRole('button', { name: 'Open Projects' }).click();
    await page.waitForURL(/\/projects\?type=model,influencer$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  });

  test('Knowledge, Team, Metrics and Goals: explanations and working CTAs', async ({ page }) => {
    await open(page, '/knowledge');
    await expect(emptyState(page, 'No articles yet')).toBeVisible();
    await expect(main(page).getByText('Create a category first, then write the first regulation or instruction.')).toBeVisible();
    const manage = main(page).getByRole('region', { name: 'Articles' }).getByRole('button', { name: 'Manage Categories' });
    await manage.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(manage).toBeFocused();

    await open(page, '/team');
    // The only member is the Owner who ran the setup.
    const rows = page.getByRole('table', { name: 'Team members' }).getByRole('row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText('Olga Owner');
    await page.getByRole('tab', { name: 'Invitations' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Invitations' }).getByRole('heading', { level: 2 })).toBeVisible();
    const invite = page.getByRole('button', { name: 'Invite' }).first();
    await invite.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(invite).toBeFocused();

    await open(page, '/metrics');
    await expect(emptyState(page, 'Nothing is due right now')).toBeVisible();
    await main(page).getByRole('button', { name: 'Add Metrics' }).last().click();
    await page.waitForURL(/\/metrics\/new/);

    await open(page, '/goals');
    await expect(emptyState(page, 'No goals yet')).toBeVisible();
    await main(page).getByRole('button', { name: 'New Goal' }).last().click();
    await expect(page.getByRole('dialog').or(page.getByRole('heading', { level: 1, name: 'New Goal' }))).toBeVisible();
  });
});
