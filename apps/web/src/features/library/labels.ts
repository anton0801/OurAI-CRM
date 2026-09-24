import { registerLabels } from '@/lib/labels';

/** Library vocabulary (asset kinds, processing states, sensitivity, link roles). */
registerLabels({
  assetKind: { image: 'Image', video: 'Video', audio: 'Audio', document: 'Document', archive: 'Archive', other: 'Other', external_link: 'External Link' },
  assetStatus: {
    uploading: 'Uploading',
    uploaded: 'Uploaded',
    checking: 'Checking',
    processing: 'Processing',
    available: 'Available',
    rejected: 'Rejected',
    failed: 'Failed',
    external: 'External Link',
  },
  sensitivity: { normal: 'Normal', restricted: 'Restricted Media' },
  linkRole: { attachment: 'Attachment', embedded: 'Used in article text', cover: 'Cover', approved_cover: 'Approved cover', evidence: 'Evidence', reference: 'Reference' },
  entityType: {
    project: 'Project',
    article: 'Knowledge Article',
    task: 'Task',
    content_item: 'Content',
    reference: 'Reference',
    account: 'Account',
    publication: 'Publication',
    character: 'Character',
    campaign: 'Campaign',
    deal: 'Deal',
    partner: 'Partner',
    shift: 'Shift',
    financial_entry: 'Financial Entry',
  },
});
