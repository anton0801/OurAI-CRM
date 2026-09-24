import type { AssetView, FolderView } from '@castlane/api-contracts';

/** Folder and all its descendants. */
export const subtreeOf = (folders: FolderView[], id: string): string[] => {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const f of folders) if (f.parentId === out[i]) out.push(f.id);
  return out;
};

/** What the Library shows as the processing state: external link, the newest pending version, or the current file. */
export const effectiveStatus = (a: Pick<AssetView, 'kind' | 'currentVersion' | 'pendingVersion'>): string => {
  if (a.kind === 'external_link') return 'external';
  if (a.pendingVersion) return a.pendingVersion.status;
  return a.currentVersion?.status ?? 'uploading';
};

export const previewKind = (mime: string | null | undefined): 'image' | 'video' | 'audio' | 'document' | 'other' => {
  if (!mime) return 'other';
  if (/^image\/(jpeg|png|webp|gif)$/.test(mime)) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
};

export const formatDurationMs = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined) return null;
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};

/** Split a comma separated tag input (validated again on the server). */
export const splitTags = (v: string) =>
  v
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
