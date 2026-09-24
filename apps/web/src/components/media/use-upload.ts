'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { mediaEndpoints } from '@castlane/api-contracts';
import { isApiError, newIdempotencyKey } from '@castlane/api-client';
import { api } from '@/lib/api';

export type UploadPurpose = 'content' | 'avatar' | 'logo' | 'cover' | 'reference' | 'evidence' | 'document' | 'import' | 'general';

export type UploadState =
  | 'queued'
  | 'hashing'
  | 'duplicate'
  | 'uploading'
  | 'paused'
  | 'completing'
  | 'checking'
  | 'processing'
  | 'available'
  | 'failed'
  | 'cancelled'
  | 'rejected';

export interface UploadItem {
  key: string;
  file: File;
  state: UploadState;
  progress: number;
  error?: string;
  /** Error code from the server (e.g. QUOTA_EXCEEDED) for specific guidance. */
  errorCode?: string;
  assetId?: string;
  assetVersionId?: string;
  uploadId?: string;
  checksum?: string;
  /** Readable files with identical content (reuse instead of uploading again). */
  duplicates?: { assetId: string; versionId: string; name: string; versionNo: number }[];
}

export interface UploadOptions {
  workspaceId: string;
  purpose: UploadPurpose;
  projectId?: string | null;
  folderId?: string | null;
  assetId?: string;
  sensitivity?: 'normal' | 'restricted';
  target?: { entityType: string; entityId: string; role?: string };
  note?: string;
  onUploaded?: (item: UploadItem) => void;
  /** Check readable duplicates (SHA-256 in the browser) before uploading files up to 100 MB. */
  checkDuplicates?: boolean;
  /** Parallel uploads (default 2). */
  concurrency?: number;
}

const HASH_LIMIT = 100 * 1024 * 1024;

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

const sha256 = async (file: File) => {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

type RunMode = 'normal' | 'skipDuplicateCheck';

/**
 * Resumable multipart upload manager: initiate (quota reservation) → PUT parts to short-lived URLs
 * that only target this session's quarantine → complete → server-side checks. Pause stops the
 * transfer; Resume and Retry continue with the parts the server already has (24 h session).
 * Nothing is "Available" until the server says so; Checking and Processing are shown separately.
 */
export const useUpload = (opts: UploadOptions) => {
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  itemsRef.current = items;
  const controllers = useRef(new Map<string, { ctrl: AbortController; reason?: 'pause' | 'cancel' }>());
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const running = useRef(0);
  const waiting = useRef<{ key: string; mode: RunMode }[]>([]);
  const patch = (key: string, p: Partial<UploadItem>) =>
    setItems((list) => {
      const next = list.map((i) => (i.key === key ? { ...i, ...p } : i));
      itemsRef.current = next;
      return next;
    });
  const current = (key: string) => itemsRef.current.find((i) => i.key === key);

  const runOne = async (key: string, mode: RunMode) => {
    const o = optsRef.current;
    const item = current(key);
    if (!item) return;
    const ctrl = new AbortController();
    controllers.current.set(key, { ctrl });
    const { file } = item;
    try {
      let checksum = item.checksum;
      if (!item.uploadId && o.checkDuplicates && mode === 'normal' && file.size <= HASH_LIMIT && typeof crypto !== 'undefined' && crypto.subtle) {
        patch(key, { state: 'hashing', error: undefined });
        checksum = await sha256(file);
        patch(key, { checksum });
        const dups = await api.call(mediaEndpoints.duplicates, { params: { workspaceId: o.workspaceId }, query: { checksum } }, { signal: ctrl.signal });
        if (dups.length) {
          patch(key, { state: 'duplicate', duplicates: dups });
          return;
        }
      }
      patch(key, { state: 'uploading', error: undefined, errorCode: undefined });
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
            params: { workspaceId: o.workspaceId },
            body: {
              filename: file.name,
              mimeType: file.type || 'application/octet-stream',
              byteSize: file.size,
              checksumSha256: checksum,
              purpose: o.purpose,
              projectId: o.projectId ?? undefined,
              folderId: o.folderId ?? undefined,
              assetId: o.assetId,
              sensitivity: o.sensitivity,
              target: o.target,
              note: o.note,
            },
          },
          { idempotencyKey: newIdempotencyKey(), signal: ctrl.signal },
        );
        uploadId = init.uploadId;
        assetId = init.assetId;
        assetVersionId = init.assetVersionId;
        parts = init.parts;
        partSize = init.partSize;
        patch(key, { uploadId, assetId, assetVersionId });
      } else {
        const resume = await api.call(mediaEndpoints.resumeUpload, { params: { workspaceId: o.workspaceId, uploadId } }, { signal: ctrl.signal });
        if (resume.state !== 'open') throw Object.assign(new Error('The upload session expired or was closed. Remove the file and add it again.'), { code: 'SESSION_CLOSED' });
        resume.uploaded.forEach((p) => done.set(p.partNumber, p.etag));
        parts = resume.missing;
        if (resume.uploaded[0]) partSize = Math.max(partSize, resume.uploaded[0].size);
      }
      const loaded = new Map<number, number>();
      for (const n of done.keys()) loaded.set(n, Math.min(partSize, file.size - (n - 1) * partSize));
      const report = () => patch(key, { progress: Math.min(99, Math.round(([...loaded.values()].reduce((a, b) => a + b, 0) / Math.max(1, file.size)) * 100)) });
      report();
      for (const p of parts) {
        const blob = file.slice((p.partNumber - 1) * partSize, p.partNumber * partSize);
        const etag = await putPart(
          p.url,
          blob,
          (l) => {
            loaded.set(p.partNumber, l);
            report();
          },
          ctrl.signal,
        );
        done.set(p.partNumber, etag);
      }
      patch(key, { state: 'completing' });
      const allParts = [...done.entries()].sort((a, b) => a[0] - b[0]).map(([partNumber, etag]) => ({ partNumber, etag }));
      // The upload id is a UUID: reusing it as the Idempotency-Key makes a repeated Complete harmless.
      const complete = await api.call(mediaEndpoints.completeUpload, { params: { workspaceId: o.workspaceId, uploadId: uploadId! }, body: { parts: allParts } }, { idempotencyKey: uploadId });
      patch(key, { state: complete.status === 'rejected' ? 'rejected' : 'checking', progress: 100 });
      if (complete.status === 'rejected') return;
      // Poll the verification result (the worker scans, stores and prepares previews).
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, i < 10 ? 1000 : 3000));
        if (ctrl.signal.aborted) return;
        const a = await api.call(mediaEndpoints.get, { params: { workspaceId: o.workspaceId, assetId: assetId! } });
        const v = a.versions.find((x) => x.id === assetVersionId);
        if (v?.status === 'available') {
          patch(key, { state: 'available' });
          o.onUploaded?.({ ...item, state: 'available', assetId, assetVersionId, uploadId, progress: 100 });
          return;
        }
        if (v?.status === 'rejected' || v?.status === 'failed') {
          patch(key, { state: 'rejected', error: v.rejectionReason ?? 'The file was rejected.' });
          return;
        }
        if (v?.status === 'processing') patch(key, { state: 'processing' });
      }
      patch(key, { error: 'Still being checked. The file appears in the Library when it is ready.' });
    } catch (e) {
      const reason = controllers.current.get(key)?.reason;
      if (reason === 'pause') patch(key, { state: 'paused' });
      else if (reason === 'cancel' || ctrl.signal.aborted) patch(key, { state: 'cancelled' });
      else patch(key, { state: 'failed', error: isApiError(e) ? e.message : (e as Error).message, errorCode: isApiError(e) ? e.code : (e as { code?: string }).code });
    } finally {
      controllers.current.delete(key);
    }
  };

  const pump = useCallback(() => {
    const limit = optsRef.current.concurrency ?? 2;
    while (running.current < limit && waiting.current.length) {
      const next = waiting.current.shift()!;
      running.current++;
      void runOne(next.key, next.mode).finally(() => {
        running.current--;
        pump();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enqueue = useCallback(
    (key: string, mode: RunMode = 'normal') => {
      waiting.current.push({ key, mode });
      pump();
    },
    [pump],
  );

  const add = useCallback(
    (files: FileList | File[]) => {
      const next = [...files].map((file) => ({ key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`, file, state: 'queued' as const, progress: 0 }));
      setItems((l) => {
        const all = [...l, ...next];
        itemsRef.current = all;
        return all;
      });
      next.forEach((i) => enqueue(i.key));
    },
    [enqueue],
  );

  /** Continue an unfinished server session (after a reload) with the same file chosen again. */
  const resumeSession = useCallback(
    (session: { uploadId: string; assetId: string | null; assetVersionId: string | null }, file: File) => {
      const item: UploadItem = { key: `${session.uploadId}`, file, state: 'queued', progress: 0, uploadId: session.uploadId, assetId: session.assetId ?? undefined, assetVersionId: session.assetVersionId ?? undefined };
      setItems((l) => {
        const all = [...l.filter((i) => i.key !== item.key), item];
        itemsRef.current = all;
        return all;
      });
      enqueue(item.key);
    },
    [enqueue],
  );

  const retry = useCallback((key: string) => enqueue(key), [enqueue]);
  const uploadAnyway = useCallback((key: string) => enqueue(key, 'skipDuplicateCheck'), [enqueue]);

  const pause = useCallback((key: string) => {
    const c = controllers.current.get(key);
    if (c) {
      c.reason = 'pause';
      c.ctrl.abort();
    }
  }, []);

  const cancel = useCallback(async (key: string) => {
    const c = controllers.current.get(key);
    if (c) {
      c.reason = 'cancel';
      c.ctrl.abort();
    }
    waiting.current = waiting.current.filter((w) => w.key !== key);
    const i = current(key);
    if (i?.uploadId && ['uploading', 'paused', 'failed', 'queued'].includes(i.state))
      await api.call(mediaEndpoints.abortUpload, { params: { workspaceId: optsRef.current.workspaceId, uploadId: i.uploadId }, body: {} }).catch(() => undefined);
    patch(key, { state: 'cancelled' });
  }, []);

  const dismiss = useCallback((key: string) => setItems((l) => l.filter((i) => i.key !== key)), []);
  const clear = useCallback(() => setItems((l) => l.filter((i) => !['available', 'cancelled', 'rejected', 'duplicate'].includes(i.state))), []);

  useEffect(
    () => () => {
      for (const c of controllers.current.values()) c.ctrl.abort();
    },
    [],
  );

  const active = items.filter((i) => ['queued', 'hashing', 'uploading', 'completing'].includes(i.state)).length;
  return { items, add, retry, pause, resume: retry, cancel, dismiss, clear, uploadAnyway, resumeSession, active };
};
