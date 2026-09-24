import { Readable } from 'node:stream';
import { getAppServices } from '@castlane/application';
import { FilesystemStorage } from '@castlane/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Development/test storage driver: accepts one multipart part for a signed, expiring URL — the
 * local equivalent of an S3 presigned UploadPart. It can only write into the quarantine upload.
 */
export async function PUT(req: Request) {
  const app = getAppServices();
  const storage = app.storage;
  if (!(storage instanceof FilesystemStorage)) return new Response('Not found', { status: 404 });
  const u = new URL(req.url);
  const key = u.searchParams.get('key') ?? '';
  const uploadId = u.searchParams.get('uploadId') ?? '';
  const part = Number(u.searchParams.get('part'));
  const exp = Number(u.searchParams.get('exp'));
  const sig = u.searchParams.get('sig') ?? '';
  if (!key.startsWith('quarantine/') || !Number.isInteger(part) || part < 1 || part > 10000 || exp < Date.now() || !storage.verify(`put:${key}:${uploadId}:${part}:${exp}`, sig))
    return new Response('Forbidden', { status: 403 });
  if (!req.body) return new Response('Empty body', { status: 400 });
  const r = await storage.writePart(uploadId, part, Readable.fromWeb(req.body as never));
  return new Response(null, { status: 200, headers: { etag: r.etag, 'access-control-expose-headers': 'ETag' } });
}
