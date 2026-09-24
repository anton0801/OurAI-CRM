'use client';
import { importEndpoints } from '@castlane/api-contracts';
import { newIdempotencyKey } from '@castlane/api-client';
import { api } from '@/lib/api';

const putPart = (url: string, blob: Blob, onProgress: (loaded: number) => void) =>
  new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.getResponseHeader('ETag') ?? '') : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Network error while uploading. Retry when the connection is back.'));
    xhr.send(blob);
  });

/**
 * Upload an import file into quarantine (short-lived part URLs), then create the import job: the
 * server verifies size, content and malware scan before anything is parsed. Nothing in the domain changes.
 */
export const uploadImportFile = async (workspaceId: string, dataset: string, file: File, onProgress: (percent: number) => void) => {
  const init = await api.call(importEndpoints.initiateUpload, { params: { workspaceId }, body: { filename: file.name, byteSize: file.size, mimeType: file.type || undefined } }, { idempotencyKey: newIdempotencyKey() });
  const loaded = new Map<number, number>();
  const parts: { partNumber: number; etag: string }[] = [];
  for (const p of init.parts) {
    const blob = file.slice((p.partNumber - 1) * init.partSize, p.partNumber * init.partSize);
    const etag = await putPart(p.url, blob, (l) => {
      loaded.set(p.partNumber, l);
      onProgress(Math.min(99, Math.round(([...loaded.values()].reduce((a, b) => a + b, 0) / Math.max(1, file.size)) * 100)));
    });
    parts.push({ partNumber: p.partNumber, etag });
  }
  const job = await api.call(importEndpoints.create, { params: { workspaceId }, body: { uploadId: init.uploadId, parts, dataset: dataset as never } }, { idempotencyKey: newIdempotencyKey() });
  onProgress(100);
  return job;
};
