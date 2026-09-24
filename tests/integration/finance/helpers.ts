import { financeEndpoints as F, type EndpointBody } from '@castlane/api-contracts';
import { getAppServices } from '@castlane/application';
import { addMember, clientFor, createProject, createWorkspace, sessionFor, type TestClient } from '../../support';

export const db = () => getAppServices().db;

type EntryBody = EndpointBody<typeof F.entriesCreate>;

/** Workspace (EUR) with Owner, a Finance Manager and one project; category ids by key. */
export const financeSetup = async (opts: { currency?: string } = {}) => {
  const ws = await createWorkspace(db(), { currency: opts.currency ?? 'EUR' });
  const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
  const fm = await addMember(db(), ws, { roleKey: 'finance_manager', name: 'Fiona Finance' });
  const fmc = await clientFor(await sessionFor(db(), fm.userId));
  const project = await createProject(db(), ws, { name: 'Model Alpha', type: 'model' });
  const p = { workspaceId: ws.workspaceId };
  const cats = await owner.call(F.categoriesList, { params: p, query: {} });
  const cat = (key: string) => {
    const c = cats.find((x) => x.key === key);
    if (!c) throw new Error(`category ${key} missing`);
    return c.id;
  };
  return { ws, owner, fm, fmc, project, p, cat };
};

/** Maker creates and submits, checker posts (maker-checker). */
export const postedEntry = async (maker: TestClient, checker: TestClient, p: { workspaceId: string }, body: EntryBody) => {
  const e = await maker.call(F.entriesCreate, { params: p, body });
  const s = await maker.call(F.entriesSubmit, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: e.rowVersion });
  return checker.call(F.entriesPost, { params: { ...p, entryId: e.id }, body: {} }, { ifMatch: s.rowVersion });
};

export const onProject = (projectId: string) => ({ mode: 'weights' as const, rows: [{ projectId, value: '1' }] });

/** The §18.7 control statement: gross 1000, refund 100, platform fee 180 → net 720. */
export const statementBody = (cat: (k: string) => string, projectId: string, extra: Partial<EntryBody> = {}): EntryBody => ({
  type: 'platform_statement',
  title: 'Platform statement March',
  recognitionDate: '2024-03-10',
  sourceNamespace: 'onlyfans',
  sourceExternalId: `stmt-${Math.random().toString(36).slice(2, 10)}`,
  controlTotal: { amount: '720.00', currency: 'EUR' },
  lines: [
    { categoryId: cat('subscriptions'), amount: '1000.00', currency: 'EUR' },
    { categoryId: cat('refund'), amount: '100.00', currency: 'EUR' },
    { categoryId: cat('platform_fee'), amount: '180.00', currency: 'EUR' },
  ],
  allocation: onProject(projectId),
  ...extra,
});

export const expenseBody = (cat: (k: string) => string, projectId: string | null, amount = '200.00', extra: Partial<EntryBody> = {}): EntryBody => ({
  type: 'expense',
  title: 'Production services',
  recognitionDate: '2024-03-12',
  lines: [{ categoryId: cat('production_services'), amount, currency: 'EUR' }],
  allocation: projectId ? onProject(projectId) : null,
  ...extra,
});

export const MARCH = { periodStart: '2024-03-01', periodEnd: '2024-03-31' };
