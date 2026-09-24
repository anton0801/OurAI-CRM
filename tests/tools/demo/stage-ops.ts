import { campaignEndpoints, dealEndpoints, financeEndpoints, knowledgeEndpoints, ofmEndpoints, partnerEndpoints } from '@castlane/api-contracts';
import type { TestClient } from '../../support/client';
import type { DemoBase } from './stage-base';
import type { DemoCtx } from './types';
import { at, day } from './types';

const text = (t: string) => [{ type: 'text' as const, text: t }];

/** Knowledge, partners and deals, a campaign, OFM operations and finance records. */
export const stageOps = async (c: DemoCtx & { base: DemoBase; clientOf: (m: { userId: string }) => Promise<TestClient> }) => {
  const { client, workspaceId: W, ownerMembershipId: owner, team, base, tz } = c;
  const params = { workspaceId: W };

  // Knowledge: a required workspace-wide regulation and a project guide.
  const cats = await client.call(knowledgeEndpoints.listCategories, { params, query: {} });
  const categoryId = cats.items[0]?.id ?? (await client.call(knowledgeEndpoints.createCategory, { params, body: { name: 'Regulations' } })).id;
  const article = async (title: string, body: ReturnType<typeof text>[], required: boolean, scope: { scopeType: 'workspace' | 'project'; scopeId?: string }) => {
    const a = await client.call(knowledgeEndpoints.create, {
      params,
      body: {
        title,
        categoryId,
        ...scope,
        ownerMembershipId: owner,
        requiredReading: required,
        body: { type: 'doc', content: body.map((b) => ({ type: 'paragraph' as const, content: b })) },
      },
    });
    const detail = await client.call(knowledgeEndpoints.get, { params: { ...params, articleId: a.id } });
    if (detail.draft?.id)
      await client.call(knowledgeEndpoints.publish, { params: { ...params, articleId: a.id }, body: { versionId: detail.draft.id, revisionKind: 'major', changeNote: 'First version' } }, { ifMatch: detail.rowVersion });
    return a.id;
  };
  await article(
    'Publishing checklist',
    [
      text('Only approved versions are scheduled. Publish on the platform yourself, then Mark Published with the real URL and time.'),
      text('If a post fails or is removed, record it with a reason — never delete the publication.'),
    ],
    true,
    { scopeType: 'workspace' },
  );
  await article('Night Shift — tone and visual rules', [text('Cold blue night palette, handheld camera feel, no gore on screen.')], false, { scopeType: 'project', scopeId: base.projects.series });

  // Partner, deal and deliverable; a campaign for the Mia Nova autumn launch.
  const partner = await client.call(partnerEndpoints.create, {
    params,
    body: { kind: 'organization', name: 'Northwind Coffee', contactName: 'Jamie Park', businessEmail: 'partners@northwind.example', ownerMembershipId: owner },
  });
  const deal = await client.call(dealEndpoints.create, {
    params,
    body: { title: 'Autumn coffee collaboration', partnerId: partner.id, ownerMembershipId: team.modelLead.membershipId, projectIds: [base.projects.model], amount: { amount: '2500.00', currency: 'EUR' }, expectedCloseDate: day(20) },
  });
  await client.call(dealEndpoints.createDeliverable, {
    params: { ...params, dealId: deal.id },
    body: { title: 'Two Instagram posts with product', format: 'image', projectId: base.projects.model, accountId: base.accounts.miaInstagram, dueAt: at(24 * 21), acceptanceCriteria: 'Product visible in frame, tagged, posted before 20:00 local time.' },
  });
  const campaign = await client.call(campaignEndpoints.create, {
    params,
    body: { name: 'Autumn launch', objective: 'Grow Mia Nova followers and test the coffee partnership.', ownerMembershipId: team.modelLead.membershipId, startDate: day(-3), endDate: day(28), projectIds: [base.projects.model], partnerId: partner.id },
  });

  // OFM: an assignment, tomorrow's shift and one contact.
  await client.call(ofmEndpoints.createAssignment, {
    params,
    body: { accountId: base.accounts.miaOnlyFans, membershipId: team.ofmManager.membershipId, validFrom: at(-24 * 7), handoverRequired: true },
  });
  await client.call(ofmEndpoints.createShift, {
    params,
    body: { membershipId: team.ofmManager.membershipId, primaryAccountId: base.accounts.miaOnlyFans, scheduledStart: at(20), scheduledEnd: at(28), timezone: tz },
  });
  await client.call(ofmEndpoints.createContact, {
    params,
    body: { accountId: base.accounts.miaOnlyFans, externalIdentifier: 'fan-1042', alias: 'Coffee lover (Berlin)', managerMembershipId: team.ofmManager.membershipId, businessNotes: 'Prefers morning replies. Asked about the autumn set.' },
  });

  // Finance: a posted AI-tools expense split across projects, and a draft platform income.
  const categories = await client.call(financeEndpoints.categoriesList, { params, query: {} });
  const cat = (cls: string, re: RegExp) => (categories.find((x) => x.accountingClass === cls && re.test(x.name)) ?? categories.find((x) => x.accountingClass === cls))!.id;
  const expense = await client.call(financeEndpoints.entriesCreate, {
    params,
    body: {
      type: 'expense',
      title: 'AI video generation subscription — September',
      recognitionDate: day(-5),
      counterparty: 'Video AI vendor',
      lines: [{ categoryId: cat('operating_expense', /tool|software|subscription|production/i), amount: '480.00', currency: 'EUR', description: 'Team plan' }],
      allocation: { mode: 'percent', rows: [{ projectId: base.projects.series, value: '60' }, { projectId: base.projects.influencer, value: '40' }] },
    },
  });
  // Submitted by the Owner, posted by the finance manager (separation of duties).
  const e1 = await client.call(financeEndpoints.entriesGet, { params: { ...params, entryId: expense.id } });
  await client.call(financeEndpoints.entriesSubmit, { params: { ...params, entryId: expense.id }, body: { note: 'Monthly subscription' } }, { ifMatch: e1.rowVersion });
  const financeClient = await c.clientOf(team.finance);
  const e2 = await financeClient.call(financeEndpoints.entriesGet, { params: { ...params, entryId: expense.id } });
  await financeClient.call(financeEndpoints.entriesPost, { params: { ...params, entryId: expense.id }, body: { approverNote: 'Matches the invoice.' } }, { ifMatch: e2.rowVersion });
  const revenue = await client.call(financeEndpoints.entriesCreate, {
    params,
    body: {
      type: 'revenue',
      title: 'Platform payout estimate — Mia Nova (September)',
      recognitionDate: day(-2),
      counterparty: 'Subscription platform',
      accountId: base.accounts.miaOnlyFans,
      lines: [{ categoryId: cat('revenue', /subscription|platform|revenue/i), amount: '1320.00', currency: 'EUR' }],
      allocation: { mode: 'percent', rows: [{ projectId: base.projects.model, value: '100' }] },
    },
  });
  const fin = { expense: expense.id, revenueDraft: revenue.id };
  return { campaign: campaign.id, deal: deal.id, partner: partner.id, finance: fin };
};
