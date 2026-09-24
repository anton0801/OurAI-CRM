import sharp from 'sharp';
import { mediaEndpoints, type EndpointBody } from '@castlane/api-contracts';
import { getAppServices } from '@castlane/application';
import { runQueuedJobs, type TestClient } from '../../support';

export const db = () => getAppServices().db;

export const png = (width = 600, height = 400, background = '#176B50') => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

/** The filesystem driver's signed part URL is served by a dedicated route handler. */
export const putPart = async (url: string, body: Buffer) => {
  const { PUT } = await import('@/../app/api/v1/storage/fs/part/route');
  return PUT(new Request(url, { method: 'PUT', body, duplex: 'half' } as RequestInit));
};

export const putParts = async (parts: { partNumber: number; url: string }[], body: Buffer, partSize: number) => {
  const etags: { partNumber: number; etag: string }[] = [];
  for (const p of parts) {
    const chunk = body.subarray((p.partNumber - 1) * partSize, p.partNumber * partSize);
    const res = await putPart(p.url, chunk);
    etags.push({ partNumber: p.partNumber, etag: res.headers.get('etag')! });
  }
  return etags;
};

type InitiateBody = EndpointBody<typeof mediaEndpoints.initiateUpload>;

/** Upload a file end to end (initiate → parts → complete → verification job). */
export const uploadFile = async (c: TestClient, workspaceId: string, body: Buffer, opts: Partial<InitiateBody> = {}, process = true) => {
  const init = await c.call(mediaEndpoints.initiateUpload, {
    params: { workspaceId },
    body: { filename: 'file.png', mimeType: 'image/png', byteSize: body.length, purpose: 'content', ...opts },
  });
  const etags = await putParts(init.parts, body, init.partSize);
  await c.call(mediaEndpoints.completeUpload, { params: { workspaceId, uploadId: init.uploadId }, body: { parts: etags } });
  if (process) await runQueuedJobs(['media.process']);
  return init;
};
