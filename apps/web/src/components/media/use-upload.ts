'use client';
import { useCallback, useRef, useState } from 'react';
import { mediaEndpoints } from '@castlane/api-contracts';
import { isApiError, newIdempotencyKey } from '@castlane/api-client';
import { api } from '@/lib/api';

export type UploadPurpose = 'content' | 'avatar' | 'logo' | 'cover' | 'reference' | 'evidence' | 'document' | 'import' | 'general';

export interface UploadItem {
  key: string;
  file: File;
  state: 'queued' | 'uploading' | 'completing' | 'checking' | 'available' | 'failed' | 'cancelled' | 'rejected';
  progress: number;
  error?: string;
  assetId?: string;
  assetVersionId?: string;
  uploadId?: string;
}

export interface UploadOptions {
  workspaceId: string;
  purpose: UploadPurpose;
  projectId?: string | null;
  folderId?: string | null;
  assetId?: string;
  sensitivity?: 'normal' | 'restricted';
  target?: { entityType: string; entityId: string; role?: string };
  onUploaded?: (item: UploadItem) => void;
}

const putPart = (url: string, blob: Blob, onProgress: (loaded: number) => void, signal: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('ETag') ?? '');
      else reject(new Error(`Part upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error while uploading'));
    signal.addEventListener('abort', () => xhr.abort());
    xhr.send(blob);
  });

/**
 * Resumable multipart upload: initiate (quota reservation) → PUT parts to short-lived URLs that
 * only target this session's quarantine → complete → server-side checks. Retry resumes missing
 * parts within the 24 h session; nothing is "Available" until the server says so.
 */
export const useUpload = (opts: UploadOptions) => {
  const [items, setItems] = useState<UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const patch = (key: string, p: Partial<UploadItem>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...p } : i)));

  const runOne = useCallback(
    async (item: UploadItem) => {
      const ctrl = new AbortController();
      controllers.current.set(item.key, ctrl);
      const { file } = item;
      try {
        patch(item.key, { state: 'uploading', error: undefined });
        let uploadId = item.uploadId;
        let parts: { partNumber: number; url: string }[];
        let partSize = 8 * 1024 * 1024;
        let assetId = item.assetId;
        let assetVersionId = item.assetVersionId;
        const done = new Map<number, string>();
        if (!uploadId) {
          const init = await api.call(
            mediaEndpoints.initiateUpload,
            {
              params: { workspaceId: opts.workspaceId },
              body: {
                filename: file.name,
                mimeType: file.type || 'application/octet-stream',
                byteSize: file.size,
                purpose: opts.purpose,
                projectId: opts.projectId ?? undefined,
                folderId: opts.folderId ?? undefined,
                assetId: opts.assetId,
                sensitivity: opts.sensitivity,
                target: opts.target,
              },
            },
            { idempotencyKey: newIdempotencyKey(), signal: ctrl.signal },
          );
          uploadId = init.uploadId;
          assetId = init.assetId;
          assetVersionId = init.assetVersionId;
          parts = init.parts;
          partSize = init.partSize;
          patch(item.key, { uploadId, assetId, assetVersionId });
        } else {
          const resume = await api.call(mediaEndpoints.resumeUpload, { params: { workspaceId: opts.workspaceId, uploadId } }, { signal: ctrl.signal });
          if (resume.state !== 'open') throw new Error('The upload session expired. Remove the file and add it again.');
          resume.uploaded.forEach((p) => done.set(p.partNumber, p.etag));
          parts = resume.missing;
        }
        const loaded = new Map<number, number>();
        for (const n of done.keys()) loaded.set(n, Math.min(partSize, file.size - (n - 1) * partSize));
        const report = () => patch(item.key, { progress: Math.min(99, Math.round(([...loaded.values()].reduce((a, b) => a + b, 0) / Math.max(1, file.size)) * 100)) });
        for (const p of parts) {
          const blob = file.slice((p.partNumber - 1) * partSize, p.partNumber * partSize);
          const etag = await putPart(p.url, blob, (l) => {
            loaded.set(p.partNumber, l);
            report();
          }, ctrl.signal);
          done.set(p.partNumber, etag);
        }
        patch(item.key, { state: 'completing' });
        const all = [...done.entries()].sort((a, b) => a[0] - b[0]).map(([partNumber, etag]) => ({ partNumber, etag }));
        const complete = await api.call(mediaEndpoints.completeUpload, { params: { workspaceId: opts.workspaceId, uploadId: uploadId! }, body: { parts: all } }, { idempotencyKey: `${uploadId}`.slice(0, 36) });
        patch(item.key, { state: complete.status === 'rejected' ? 'rejected' : 'checking', progress: 100 });
        // Poll the verification result (the worker scans, stores and prepares previews).
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, i < 10 ? 1000 : 3000));
          const a = await api.call(mediaEndpoints.get, { params: { workspaceId: opts.workspaceId, assetId: assetId! } });
          const v = a.versions.find((x) => x.id === assetVersionId);
          if (v?.status === 'available') {
            const final = { ...item, state: 'available' as const, assetId, assetVersionId, uploadId, progress: 100 };
            patch(item.key, { state: 'available' });
            opts.onUploaded?.(final);
            return;
          }
          if (v?.status === 'rejected' || v?.status === 'failed') {
            patch(item.key, { state: 'rejected', error: v.rejectionReason ?? 'The file was rejected.' });
            return;
          }
        }
        patch(item.key, { state: 'checking', error: 'Still processing. It will appear when ready.' });
      } catch (e) {
        if (ctrl.signal.aborted) patch(item.key, { state: 'cancelled' });
        else patch(item.key, { state: 'failed', error: isApiError(e) ? e.message : (e as Error).message });
      } finally {
        controllers.current.delete(item.key);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.workspaceId, opts.purpose, opts.projectId, opts.folderId, opts.assetId, opts.sensitivity, opts.target?.entityId],
  );

  const add = useCallback(
    (files: FileList | File[]) => {
      const next = [...files].map((file) => ({ key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`, file, state: 'queued' as const, progress: 0 }));
      setItems((l) => [...l, ...next]);
      next.forEach((i) => void runOne(i));
    },
    [runOne],
  );

  const retry = useCallback(
    (key: string) => {
      const i = items.find((x) => x.key === key);
      if (i) void runOne(i);
    },
    [items, runOne],
  );

  const cancel = useCallback(
    async (key: string) => {
      controllers.current.get(key)?.abort();
      const i = items.find((x) => x.key === key);
      if (i?.uploadId && (i.state === 'uploading' || i.state === 'failed'))
        await api.call(mediaEndpoints.abortUpload, { params: { workspaceId: opts.workspaceId, uploadId: i.uploadId }, body: {} }).catch(() => undefined);
      patch(key, { state: 'cancelled' });
    },
    [items, opts.workspaceId],
  );

  const clear = useCallback(() => setItems((l) => l.filter((i) => i.state !== 'available' && i.state !== 'cancelled')), []);

  return { items, add, retry, cancel, clear };
};
