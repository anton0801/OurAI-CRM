'use client';
import { EyeSlash, FileText, LinkSimple, Play, SpeakerHigh } from '@phosphor-icons/react';
import { useState } from 'react';
import { mediaEndpoints, type AssetDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Banner, Button } from '@castlane/ui';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import { previewKind } from './library-utils';

/**
 * Asset preview (S37, §6): object-fit contain; images from the authorised 1280 px derivative;
 * video/audio stream through the authorised proxy only after an explicit Play (never autoplay
 * with sound); restricted media stays a neutral placeholder until an entitled member reveals it;
 * documents without a safe preview pipeline show "File Preview Unavailable" with Download.
 */
export const AssetPreview = ({ a, onDownload }: { a: AssetDetail; onDownload: () => void }) => {
  const { workspace } = useWorkspace();
  const [revealed, setRevealed] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = a.currentVersion;
  const box = 'relative flex min-h-[240px] w-full items-center justify-center overflow-hidden rounded-[12px] bg-surface-2 md:min-h-[420px]';

  if (a.kind === 'external_link')
    return (
      <div className={box}>
        <div className="flex max-w-[520px] flex-col items-center gap-3 p-6 text-center">
          <LinkSimple size={32} className="text-fg-2" aria-hidden />
          <p className="text-[16px] font-semibold text-fg">External Link</p>
          <p className="break-all text-[13px] text-fg-2">{a.externalUrl}</p>
          <p className="text-[12px] text-fg-2">This file is not stored in Castlane. The link is not checked and may lead to a service that is unavailable.</p>
          {a.externalUrl ? (
            <a href={a.externalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center rounded-[8px] border border-line bg-surface px-3 text-[13px] font-semibold text-fg hover:bg-surface-2">
              Open Link
            </a>
          ) : null}
        </div>
      </div>
    );

  if (!v)
    return (
      <div className={box}>
        <p className="p-6 text-center text-[14px] text-fg-2">{a.pendingVersion ? 'Your file is being checked and prepared for preview.' : 'No stored version is available.'}</p>
      </div>
    );

  if (a.restrictedHidden && !revealed)
    return (
      <div className={box}>
        <div className="flex flex-col items-center gap-2 p-6 text-center text-[13px] text-fg-2">
          <EyeSlash size={28} aria-hidden />
          <span>Restricted media</span>
          {a.canReveal || a.permissions.download ? (
            <Button size="sm" onClick={() => setRevealed(true)}>
              Reveal
            </Button>
          ) : null}
        </div>
      </div>
    );

  const kind = previewKind(v.mime);
  const thumb = (size: number) => `/api/v1/workspaces/${workspace.id}/assets/${a.id}/thumbnail?size=${size}&versionId=${v.id}${a.restrictedHidden ? '&reveal=true' : ''}`;

  const loadStream = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.call(mediaEndpoints.download, { params: { workspaceId: workspace.id, assetId: a.id }, body: { versionId: v.id, disposition: 'inline' } });
      setStreamUrl(r.url);
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The file could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  if (kind === 'image' && v.previewAvailable)
    return (
      <div className={box}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={thumb(1280)} alt={a.name} className="max-h-[70vh] w-full object-contain" />
      </div>
    );

  if (kind === 'video' || kind === 'audio') {
    if (streamUrl)
      return (
        <div className={box}>
          {kind === 'video' ? (
            <video src={streamUrl} controls autoPlay className="max-h-[70vh] w-full object-contain" aria-label={a.name} />
          ) : (
            <audio src={streamUrl} controls autoPlay className="w-full max-w-[560px] p-4" aria-label={a.name} />
          )}
        </div>
      );
    return (
      <div className={box}>
        {kind === 'video' && v.previewAvailable ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb(1280)} alt="" className="absolute inset-0 h-full w-full object-contain" />
        ) : null}
        <div className="relative flex flex-col items-center gap-2 rounded-[12px] bg-surface/90 p-4 text-center">
          {a.permissions.download ? (
            <Button variant="primary" loading={loading} icon={kind === 'video' ? <Play size={14} weight="fill" /> : <SpeakerHigh size={14} />} onClick={() => void loadStream()}>
              {kind === 'video' ? 'Play' : 'Play Audio'}
            </Button>
          ) : (
            <p className="max-w-[320px] text-[13px] text-fg-2">Playback streams the original file and needs download access.</p>
          )}
          {error ? <Banner tone="danger">{error}</Banner> : null}
        </div>
      </div>
    );
  }

  return (
    <div className={box}>
      <div className="flex flex-col items-center gap-2 p-6 text-center text-[13px] text-fg-2">
        <FileText size={28} aria-hidden />
        <span>File Preview Unavailable</span>
        {a.permissions.download && v.status === 'available' ? (
          <Button size="sm" onClick={onDownload}>
            Download
          </Button>
        ) : null}
      </div>
    </div>
  );
};
