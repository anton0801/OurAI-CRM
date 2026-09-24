import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createHmac } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { ObjectHead, PresignedUpload, PutResult, StorageAdapter } from './types';

/**
 * Local filesystem driver for development and tests. Presigned URLs point at the web app's
 * `/api/v1/storage/fs/*` handler and are HMAC-signed with an expiry, mirroring S3 semantics.
 */
export class FilesystemStorage implements StorageAdapter {
  readonly driver = 'filesystem' as const;
  private readonly root: string;

  constructor(
    root: string,
    private readonly signingSecret: string,
    private readonly appOrigin: string,
  ) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    const p = resolve(this.root, 'objects', key);
    if (!p.startsWith(resolve(this.root, 'objects') + sep)) throw new Error('Invalid storage key');
    return p;
  }
  private partPath(uploadId: string, partNumber: number): string {
    if (!/^[0-9a-f-]{36}$/.test(uploadId)) throw new Error('Invalid upload id');
    return join(this.root, 'multipart', uploadId, String(partNumber).padStart(5, '0'));
  }

  sign(payload: string): string {
    return createHmac('sha256', this.signingSecret).update(payload).digest('base64url');
  }

  verify(payload: string, signature: string): boolean {
    const expected = this.sign(payload);
    return expected.length === signature.length && expected === signature;
  }

  async putObject(key: string, body: Buffer | Readable): Promise<PutResult> {
    const p = this.pathFor(key);
    await fs.mkdir(dirname(p), { recursive: true });
    if (Buffer.isBuffer(body)) await fs.writeFile(p, body);
    else await pipeline(body, createWriteStream(p));
    return { key, versionId: null };
  }

  async getObjectStream(key: string, range?: { start: number; end?: number }) {
    const p = this.pathFor(key);
    const stat = await fs.stat(p);
    const stream = createReadStream(p, range ? { start: range.start, end: range.end } : undefined);
    return { stream: stream as Readable, size: stat.size };
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const stat = await fs.stat(this.pathFor(key));
      return { key, size: stat.size, versionId: null };
    } catch {
      return null;
    }
  }

  async copyObject(sourceKey: string, targetKey: string): Promise<PutResult> {
    const target = this.pathFor(targetKey);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.copyFile(this.pathFor(sourceKey), target);
    return { key: targetKey, versionId: null };
  }

  async deleteObject(key: string): Promise<void> {
    await fs.rm(this.pathFor(key), { force: true });
  }

  async listObjects(prefix: string): Promise<string[]> {
    const base = resolve(this.root, 'objects');
    const keys: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else {
          const key = p.slice(base.length + 1).split(sep).join('/');
          if (key.startsWith(prefix)) keys.push(key);
        }
      }
    };
    // Start from the deepest directory named by the prefix.
    const dirPart = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : '';
    await walk(dirPart ? this.pathFor(dirPart) : base);
    return keys.sort();
  }

  async createMultipartUpload(): Promise<{ uploadId: string }> {
    const uploadId = randomUUID();
    await fs.mkdir(join(this.root, 'multipart', uploadId), { recursive: true });
    return { uploadId };
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number, expiresSeconds: number): Promise<PresignedUpload> {
    const expiresAt = new Date(Date.now() + expiresSeconds * 1000);
    const payload = `put:${key}:${uploadId}:${partNumber}:${expiresAt.getTime()}`;
    const qs = new URLSearchParams({
      key,
      uploadId,
      part: String(partNumber),
      exp: String(expiresAt.getTime()),
      sig: this.sign(payload),
    });
    return { url: `${this.appOrigin}/api/v1/storage/fs/part?${qs}`, method: 'PUT', headers: {}, expiresAt };
  }

  /** Called by the web handler after verifying the signature. */
  async writePart(uploadId: string, partNumber: number, body: Readable): Promise<{ etag: string; size: number }> {
    const p = this.partPath(uploadId, partNumber);
    await fs.mkdir(dirname(p), { recursive: true });
    await pipeline(body, createWriteStream(p));
    const stat = await fs.stat(p);
    return { etag: `"${uploadId}-${partNumber}-${stat.size}"`, size: stat.size };
  }

  async listParts(_key: string, uploadId: string) {
    const dir = join(this.root, 'multipart', uploadId);
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir)).sort();
    } catch {
      return [];
    }
    const out: { partNumber: number; etag: string; size: number }[] = [];
    for (const f of files) {
      const stat = await fs.stat(join(dir, f));
      const partNumber = Number(f);
      out.push({ partNumber, etag: `"${uploadId}-${partNumber}-${stat.size}"`, size: stat.size });
    }
    return out;
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<PutResult> {
    const target = this.pathFor(key);
    await fs.mkdir(dirname(target), { recursive: true });
    const out = createWriteStream(target);
    const existing = new Map((await this.listParts(key, uploadId)).map((p) => [p.partNumber, p]));
    for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
      const actual = existing.get(part.partNumber);
      if (!actual || actual.etag !== part.etag) throw new Error(`Part ${part.partNumber} does not match the uploaded data`);
      await pipeline(createReadStream(this.partPath(uploadId, part.partNumber)), out, { end: false });
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    await fs.rm(join(this.root, 'multipart', uploadId), { recursive: true, force: true });
    return { key, versionId: null };
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    await fs.rm(join(this.root, 'multipart', uploadId), { recursive: true, force: true });
  }

  async presignDownload(key: string, opts: { expiresSeconds: number; filename: string; contentType?: string }): Promise<string> {
    const exp = Date.now() + opts.expiresSeconds * 1000;
    const payload = `get:${key}:${exp}:${opts.filename}`;
    const qs = new URLSearchParams({ key, exp: String(exp), fn: opts.filename, sig: this.sign(payload) });
    if (opts.contentType) qs.set('ct', opts.contentType);
    return `${this.appOrigin}/api/v1/storage/fs/object?${qs}`;
  }

  async healthCheck() {
    try {
      await fs.mkdir(this.root, { recursive: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}
