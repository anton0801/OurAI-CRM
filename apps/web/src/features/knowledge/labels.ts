import { registerLabels } from '@/lib/labels';

/** Knowledge Base vocabulary. */
registerLabels({
  articleStatus: { draft: 'Draft', published: 'Published', archived: 'Archived' },
  articleScope: { workspace: 'Whole workspace', direction: 'Direction', project: 'Project' },
  revisionKind: { major: 'Major revision', minor: 'Minor revision' },
  readingStatus: { open: 'To read', acknowledged: 'Acknowledged', cancelled: 'Withdrawn', superseded: 'Replaced by a newer version' },
  readingSource: { member: 'Member', role: 'Role', project: 'Project team', revision: 'New version' },
  richBlock: {
    heading: 'Heading',
    paragraph: 'Paragraph',
    bullet_list: 'Bulleted list',
    ordered_list: 'Numbered list',
    checklist: 'Checklist',
    quote: 'Quote',
    table: 'Table',
    image: 'Image',
    file: 'Attached file',
  },
});
