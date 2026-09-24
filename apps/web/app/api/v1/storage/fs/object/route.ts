import { Readable } from 'node:stream';
import { getAppServices } from '@castlane/application';
import { FilesystemStorage } from '@castlane/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Development/test storage driver: signed, expiring download (local equivalent of a presigned GET). */
export async function GET(req: Request) {
  const storage = getAppServices().storage;
  if (!(storage instanceof FilesystemStorage)) return new Response('Not found', { status: 404 });
  const u = new URL(req.url);
  const key = u.searchParams.get('key') ?? '';
  const exp = Number(u.searchParams.get('exp'));
  const fn = u.searchParams.get('fn') ?? 'file';
  const sig = u.searchParams.get('sig') ?? '';
  if (!key.startsWith('assets/') || exp < Date.now() || !storage.verify(`get:${key}:${exp}:${fn}`, sig)) return new Response('Forbidden', { status: 403 });
  const obj = await storage.getObjectStream(key);
  return new Response(Readable.toWeb(obj.stream) as ReadableStream, {
    headers: {
      'content-type': u.searchParams.get('ct') ?? 'application/octet-stream',
      'content-disposition': `attachment; filename="${fn.replace(/[^\w.\- ]+/g, '_')}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
