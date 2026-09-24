/**
 * English UI dictionary for canonical enum values (section 21: system strings live in
 * dictionaries, ready for future localisation). Unknown keys fall back to humanize().
 */
import { humanize } from '@castlane/ui';

const LABELS: Record<string, Record<string, string>> = {
  projectType: { series: 'Series', model: 'Model', influencer: 'Influencer' },
  platform: { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', x: 'X', onlyfans: 'OnlyFans', fansly: 'Fansly', other: 'Custom' },
  contentFormat: {
    short_video: 'Short Video',
    episode: 'Episode',
    trailer: 'Trailer',
    image: 'Image',
    carousel: 'Carousel',
    photo_set: 'Photo Set',
    story: 'Story',
    audio: 'Audio',
    text_post: 'Text Post',
    other: 'Other',
  },
};

export const label = (group: keyof typeof LABELS | string, key: string | null | undefined): string =>
  key ? (LABELS[group]?.[key] ?? humanize(key)) : '—';
