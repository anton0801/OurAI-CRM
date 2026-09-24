import type { Readable } from 'node:stream';

export interface PutResult {
  key: string;
  versionId?: string | null;
  etag?: string;
}

export interface ObjectHead {
  key: string;
  size: number;
  contentType?: string;
  versionId?: string | null;
  etag?: string;
}

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: Date;
}

/**
 * Private object storage. All buckets are private; the application never exposes permanent
 * URLs. Upload credentials only ever target a quarantine key of one upload session.
 */
export interface StorageAdapter {
  readonly driver: 's3' | 'filesystem';
  putObject(key: string, body: Buffer | Readable, opts?: { contentType?: string; contentLength?: number }): Promise<PutResult>;
  getObjectStream(key: string, range?: { start: number; end?: number }): Promise<{ stream: Readable; size: number; contentType?: string }>;
  headObject(key: string): Promise<ObjectHead | null>;
  copyObject(sourceKey: string, targetKey: string): Promise<PutResult>;
  deleteObject(key: string): Promise<void>;
  /** Multipart upload support (resumable). */
  createMultipartUpload(key: string, contentType: string): Promise<{ uploadId: string }>;
  presignUploadPart(key: string, uploadId: string, partNumber: number, expiresSeconds: number): Promise<PresignedUpload>;
  completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<PutResult>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
  listParts(key: string, uploadId: string): Promise<{ partNumber: number; etag: string; size: number }[]>;
  /** Short-lived download URL for non-restricted files (TTL ≤ 5 min). */
  presignDownload(key: string, opts: { expiresSeconds: number; filename: string; contentType?: string }): Promise<string>;
  /** For the filesystem driver: verifies a signed part upload / download token handled by the web app. */
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}

export interface ScanResult {
  clean: boolean;
  engine: string;
  signature?: string;
  devBypass?: boolean;
}

export interface MalwareScanner {
  readonly mode: 'clamd' | 'disabled-dev-only';
  scan(stream: Readable): Promise<ScanResult>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
