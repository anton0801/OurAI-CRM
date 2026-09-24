import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { ObjectHead, PresignedUpload, PutResult, StorageAdapter } from './types';

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/** S3-compatible private bucket driver. Presigned URLs are bearer credentials with TTL ≤ 5 minutes. */
export class S3Storage implements StorageAdapter {
  readonly driver = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async putObject(key: string, body: Buffer | Readable, opts: { contentType?: string; contentLength?: number } = {}): Promise<PutResult> {
    const r = await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: opts.contentType, ContentLength: opts.contentLength }),
    );
    return { key, versionId: r.VersionId ?? null, etag: r.ETag };
  }

  async getObjectStream(key: string, range?: { start: number; end?: number }) {
    const r = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined }),
    );
    return { stream: r.Body as Readable, size: Number(r.ContentLength ?? 0), contentType: r.ContentType };
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { key, size: Number(r.ContentLength ?? 0), contentType: r.ContentType, versionId: r.VersionId ?? null, etag: r.ETag };
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFound') return null;
      throw e;
    }
  }

  async copyObject(sourceKey: string, targetKey: string): Promise<PutResult> {
    const r = await this.client.send(
      new CopyObjectCommand({ Bucket: this.bucket, Key: targetKey, CopySource: `${this.bucket}/${encodeURIComponent(sourceKey)}` }),
    );
    return { key: targetKey, versionId: r.VersionId ?? null, etag: r.CopyObjectResult?.ETag };
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async listObjects(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }

  async createMultipartUpload(key: string, contentType: string) {
    const r = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }));
    if (!r.UploadId) throw new Error('Storage did not return an upload id');
    return { uploadId: r.UploadId };
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number, expiresSeconds: number): Promise<PresignedUpload> {
    const url = await getSignedUrl(
      this.client,
      new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
      { expiresIn: expiresSeconds },
    );
    return { url, method: 'PUT', headers: {}, expiresAt: new Date(Date.now() + expiresSeconds * 1000) };
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<PutResult> {
    const r = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
      }),
    );
    return { key, versionId: r.VersionId ?? null, etag: r.ETag };
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
  }

  async listParts(key: string, uploadId: string) {
    const r = await this.client.send(new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
    return (r.Parts ?? []).map((p) => ({ partNumber: p.PartNumber ?? 0, etag: p.ETag ?? '', size: Number(p.Size ?? 0) }));
  }

  async presignDownload(key: string, opts: { expiresSeconds: number; filename: string; contentType?: string }): Promise<string> {
    const safe = opts.filename.replace(/[^\w.\- ]+/g, '_');
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safe}"`,
        ResponseContentType: opts.contentType,
      }),
      { expiresIn: Math.min(opts.expiresSeconds, 300) },
    );
  }

  async healthCheck() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).name };
    }
  }
}
