import { and, eq } from 'drizzle-orm';
import { importEndpoints, type ImportOptionsInput } from '@castlane/api-contracts';
import { getAppServices, notify, type NotifyInput } from '@castlane/application';
import { roles, roleAssignments, userPreferences } from '@castlane/database';
import { newId } from '@castlane/domain';
import { runQueuedJobs, type TestClient, type TestWorkspace } from '../../support';

export const db = () => getAppServices().db;

/** PUT one signed part through the filesystem storage route (local S3 equivalent). */
const putPart = async (url: string, body: Buffer) => {
  const { PUT } = await import('@/../app/api/v1/storage/fs/part/route');
  const res = await PUT(new Request(url, { method: 'PUT', body, duplex: 'half' } as RequestInit));
  if (res.status !== 200) throw new Error(`part upload failed: ${res.status}`);
  return res.headers.get('etag')!;
};

/** Upload a file into import quarantine, create the import job and run parsing. */
export const uploadImport = async (c: TestClient, workspaceId: string, file: { name: string; body: Buffer }, dataset = 'projects') => {
  const init = await c.call(importEndpoints.initiateUpload, { params: { workspaceId }, body: { filename: file.name, byteSize: file.body.length } });
  const parts = [];
  for (let i = 0; i < init.parts.length; i++) parts.push({ partNumber: i + 1, etag: await putPart(init.parts[i]!.url, file.body.subarray(i * init.partSize, (i + 1) * init.partSize)) });
  const job = await c.call(importEndpoints.create, { params: { workspaceId }, body: { uploadId: init.uploadId, parts, dataset: dataset as never } });
  await runQueuedJobs(['imports.parse']);
  return c.call(importEndpoints.get, { params: { workspaceId, importId: job.id } });
};

export const defaultImportOptions = (o: Partial<ImportOptionsInput> = {}): ImportOptionsInput => ({
  timezone: 'Europe/Berlin',
  dateFormat: 'iso',
  decimalSeparator: '.',
  duplicatePolicy: 'error',
  acceptCachedFormulaValues: false,
  ...o,
});

export const validateImport = async (c: TestClient, workspaceId: string, importId: string, mapping?: Record<string, string | null>, options: Partial<ImportOptionsInput> = {}) => {
  const cur = await c.call(importEndpoints.get, { params: { workspaceId, importId } });
  await c.call(importEndpoints.validate, { params: { workspaceId, importId }, body: { mapping: mapping ?? cur.mapping, options: defaultImportOptions(options) } }, { ifMatch: cur.rowVersion });
  await runQueuedJobs(['imports.validate']);
  return c.call(importEndpoints.get, { params: { workspaceId, importId } });
};

export const csv = (lines: string[]) => Buffer.from(`${lines.join('\n')}\n`, 'utf8');

/** A custom role with the given permissions (for scope tests beyond the presets). */
export const customRole = async (ws: TestWorkspace, key: string, permissions: string[]) => {
  const id = newId();
  const at = new Date();
  await db().insert(roles).values({ id, workspaceId: ws.workspaceId, key, name: key, permissions, createdAt: at, updatedAt: at });
  return id;
};

export const grantRole = async (ws: TestWorkspace, membershipId: string, roleId: string, scopeType: 'workspace' | 'project' | 'assigned_projects', scopeId: string | null = null) => {
  const at = new Date();
  await db().insert(roleAssignments).values({ id: newId(), workspaceId: ws.workspaceId, membershipId, roleId, scopeType, scopeId, validFrom: new Date(at.getTime() - 1000), createdAt: at, updatedAt: at });
};

export const sendNotification = (input: Omit<NotifyInput, 'at'> & { at?: Date }) => notify(db(), { at: input.at ?? getAppServices().clock.now(), ...input });

export const setPrefs = async (userId: string, prefs: Partial<typeof userPreferences.$inferInsert>) => {
  await db().update(userPreferences).set(prefs).where(and(eq(userPreferences.userId, userId)));
};
