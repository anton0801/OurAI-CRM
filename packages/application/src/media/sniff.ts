/**
 * Content-type detection from magic bytes. The browser-declared type and the file extension are
 * never trusted (OWASP File Upload guidance).
 */
export type SniffedKind = 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other';

export interface Sniffed {
  mime: string;
  kind: SniffedKind;
  /** Preview-safe rendering is possible with the built-in pipeline. */
  previewable: boolean;
}

const startsWith = (b: Buffer, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);
const ascii = (b: Buffer, start: number, end: number) => b.subarray(start, end).toString('latin1');

export const sniff = (head: Buffer, filename: string): Sniffed | null => {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', kind: 'image', previewable: true };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', kind: 'image', previewable: true };
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return { mime: 'image/gif', kind: 'image', previewable: true };
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image', previewable: true };
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WAVE') return { mime: 'audio/wav', kind: 'audio', previewable: true };
  if (ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    if (brand === 'qt  ') return { mime: 'video/quicktime', kind: 'video', previewable: false };
    if (brand.startsWith('M4A')) return { mime: 'audio/mp4', kind: 'audio', previewable: true };
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return null;
    return { mime: 'video/mp4', kind: 'video', previewable: true };
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: 'video/webm', kind: 'video', previewable: true };
  if (ascii(head, 0, 3) === 'ID3' || startsWith(head, [0xff, 0xfb]) || startsWith(head, [0xff, 0xf3]) || startsWith(head, [0xff, 0xf2]))
    return { mime: 'audio/mpeg', kind: 'audio', previewable: true };
  if (ascii(head, 0, 5) === '%PDF-') return { mime: 'application/pdf', kind: 'document', previewable: false };
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    const text = head.toString('latin1');
    if (ext === 'docx' || text.includes('word/')) return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'document', previewable: false };
    if (ext === 'xlsx' || text.includes('xl/')) return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'document', previewable: false };
    return { mime: 'application/zip', kind: 'archive', previewable: false };
  }
  // Text formats: valid UTF-8 without NUL bytes.
  if (!head.includes(0)) {
    const text = head.toString('utf8');
    if (!text.includes('�')) {
      const t = text.trimStart().slice(0, 512).toLowerCase();
      if (t.includes('<svg')) return { mime: 'image/svg+xml', kind: 'image', previewable: true };
      if (ext === 'csv') return { mime: 'text/csv', kind: 'document', previewable: false };
      if (ext === 'srt' || ext === 'vtt') return { mime: ext === 'vtt' ? 'text/vtt' : 'application/x-subrip', kind: 'document', previewable: false };
      if (ext === 'txt' || ext === 'md') return { mime: 'text/plain', kind: 'document', previewable: false };
    }
  }
  return null;
};

export type UploadPurpose = 'content' | 'avatar' | 'logo' | 'cover' | 'reference' | 'evidence' | 'document' | 'import' | 'general';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Per-kind and per-purpose limits (section 6). */
export const sizeLimit = (purpose: UploadPurpose, mime: string, maxUpload: number): number => {
  if (purpose === 'avatar' || purpose === 'logo') return 10 * MB;
  if (purpose === 'cover') return 20 * MB;
  if (purpose === 'import') return 20 * MB;
  if (mime.startsWith('image/')) return 50 * MB;
  if (mime.startsWith('video/')) return Math.min(5 * GB, maxUpload);
  if (mime.startsWith('audio/')) return 500 * MB;
  if (mime === 'application/pdf') return 100 * MB;
  if (mime.includes('officedocument')) return 50 * MB;
  if (mime === 'application/zip') return 2 * GB;
  return 50 * MB;
};

/** Maximum decoded pixels for raster images (decompression-bomb guard). */
export const pixelLimit = (purpose: UploadPurpose): number => {
  if (purpose === 'avatar' || purpose === 'logo') return 4096 * 4096;
  if (purpose === 'cover') return 12000 * 12000;
  return 100_000_000;
};

export const DECLARED_ALLOWLIST = [
  /^image\/(jpeg|png|webp|gif|svg\+xml)$/,
  /^video\/(mp4|quicktime|webm)$/,
  /^audio\/(mpeg|mp3|wav|x-wav|wave|mp4|x-m4a|m4a)$/,
  /^application\/(pdf|zip|x-zip-compressed|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet))$/,
  /^text\/(csv|plain|vtt)$/,
  /^application\/(x-subrip|octet-stream)$/,
];

export const isDeclaredAllowed = (mime: string) => DECLARED_ALLOWLIST.some((re) => re.test(mime));
