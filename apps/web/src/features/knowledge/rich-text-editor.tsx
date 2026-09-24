'use client';
import { ArrowDown, ArrowUp, Plus, Trash } from '@phosphor-icons/react';
import type { RichBlock, RichTextDocument } from '@castlane/api-contracts';
import { Button, Field, IconButton, Input, Menu, Select, Switch, Textarea } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { FileUploader } from '@/components/media/file-uploader';
import { label } from '@/lib/labels';
import { useWorkspace } from '@/lib/workspace-context';
import { parseInlines, serializeInlines } from './inline-markup';

/**
 * Editor model: one entry per block. Text blocks keep their inline markup source; lists and
 * checklists one item per line; tables one row per line with cells separated by " | ".
 */
export interface EditorBlock {
  key: string;
  type: RichBlock['type'];
  level?: 1 | 2 | 3;
  text: string;
  header?: boolean;
  checklistIds?: string[];
  assetId?: string | null;
  versionId?: string;
  alt?: string;
  caption?: string;
}

let seq = 0;
const newKey = () => `b${Date.now().toString(36)}${(seq++).toString(36)}`;

export const toEditorBlocks = (doc: RichTextDocument): EditorBlock[] =>
  doc.content.map((b): EditorBlock => {
    const key = newKey();
    switch (b.type) {
      case 'heading':
        return { key, type: 'heading', level: b.level, text: serializeInlines(b.content) };
      case 'paragraph':
      case 'quote':
        return { key, type: b.type, text: serializeInlines(b.content) };
      case 'bullet_list':
      case 'ordered_list':
        return { key, type: b.type, text: b.items.map((it) => serializeInlines(it)).join('\n') };
      case 'checklist':
        return { key, type: 'checklist', text: b.items.map((it) => serializeInlines(it.content)).join('\n'), checklistIds: b.items.map((it) => it.id) };
      case 'table':
        return { key, type: 'table', header: b.header, text: b.rows.map((r) => r.map((c) => serializeInlines(c).replace(/\|/g, '\\|')).join(' | ')).join('\n') };
      case 'image':
        return { key, type: 'image', text: '', assetId: b.assetId, versionId: b.versionId, alt: b.alt, caption: b.caption ?? '' };
      case 'file':
        return { key, type: 'file', text: b.label ?? '', assetId: b.assetId, versionId: b.versionId };
    }
  });

const lines = (t: string) =>
  t
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

export const toDoc = (blocks: EditorBlock[]): RichTextDocument => ({
  type: 'doc',
  content: blocks.flatMap((b): RichBlock[] => {
    switch (b.type) {
      case 'heading':
        return [{ type: 'heading', level: b.level ?? 2, content: parseInlines(b.text) }];
      case 'paragraph':
        return [{ type: 'paragraph', content: parseInlines(b.text) }];
      case 'quote':
        return [{ type: 'quote', content: parseInlines(b.text) }];
      case 'bullet_list':
      case 'ordered_list': {
        const items = lines(b.text).map(parseInlines);
        return items.length ? [{ type: b.type, items }] : [];
      }
      case 'checklist': {
        const items = lines(b.text).map((l, i) => ({ id: b.checklistIds?.[i] ?? `item-${i + 1}`, content: parseInlines(l) }));
        return items.length ? [{ type: 'checklist', items }] : [];
      }
      case 'table': {
        const rows = lines(b.text).map((l) => l.split(/(?<!\\)\|/).map((c) => parseInlines(c.trim().replace(/\\\|/g, '|'))));
        return rows.length ? [{ type: 'table', header: !!b.header, rows }] : [];
      }
      case 'image':
        return b.assetId ? [{ type: 'image', assetId: b.assetId, ...(b.versionId ? { versionId: b.versionId } : {}), alt: b.alt ?? '', ...(b.caption?.trim() ? { caption: b.caption.trim() } : {}) }] : [];
      case 'file':
        return b.assetId ? [{ type: 'file', assetId: b.assetId, ...(b.versionId ? { versionId: b.versionId } : {}), ...(b.text.trim() ? { label: b.text.trim() } : {}) }] : [];
    }
  }),
});

const ADDABLE: RichBlock['type'][] = ['paragraph', 'heading', 'bullet_list', 'ordered_list', 'checklist', 'quote', 'table', 'image', 'file'];

const blank = (type: RichBlock['type']): EditorBlock => ({ key: newKey(), type, text: '', ...(type === 'heading' ? { level: 2 as const } : {}), ...(type === 'table' ? { header: true } : {}), ...(type === 'image' || type === 'file' ? { assetId: null, alt: '', caption: '' } : {}) });

const PLACEHOLDER: Partial<Record<RichBlock['type'], string>> = {
  paragraph: 'Write text. **bold**, *italic*, `code`, [link](https://…)',
  heading: 'Heading',
  quote: 'Quote',
  bullet_list: 'One item per line',
  ordered_list: 'One step per line',
  checklist: 'One checklist item per line',
  table: 'One row per line, cells separated by |',
};

/**
 * Block editor for knowledge articles (structured rich text, no HTML). Every action has a
 * keyboard-reachable button (Move Up / Move Down instead of drag and drop).
 */
export const RichTextEditor = ({
  blocks,
  onChange,
  articleId,
  disabled,
  canUpload,
}: {
  blocks: EditorBlock[];
  onChange: (blocks: EditorBlock[]) => void;
  articleId: string;
  disabled?: boolean;
  canUpload: boolean;
}) => {
  const { workspace } = useWorkspace();
  const update = (key: string, patch: Partial<EditorBlock>) => onChange(blocks.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const insertAt = (i: number, type: RichBlock['type']) => {
    const next = [...blocks];
    next.splice(i, 0, blank(type));
    onChange(next);
  };
  const addMenu = (at: number, text: string) => (
    <Menu
      label="Add block"
      align="start"
      trigger={
        <Button size="sm" variant="ghost" icon={<Plus size={12} />} disabled={disabled}>
          {text}
        </Button>
      }
      items={ADDABLE.map((t) => ({ label: label('richBlock', t), onSelect: () => insertAt(at, t) }))}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-fg-2">Formatting inside text: **bold**, *italic*, `code`, [link text](https://example.com). Links must start with http:// or https://.</p>
      {blocks.length === 0 ? <p className="text-[14px] text-fg-2">The article has no content yet. Add a first block.</p> : null}
      <ol className="flex flex-col gap-3">
        {blocks.map((b, i) => (
          <li key={b.key} className="rounded-[12px] border border-line bg-surface p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-[550] text-fg-2">{label('richBlock', b.type)}</span>
              {b.type === 'heading' ? (
                <div className="w-[120px]">
                  <Select
                    aria-label="Heading level"
                    value={String(b.level ?? 2)}
                    onChange={(v) => update(b.key, { level: Number(v ?? 2) as 1 | 2 | 3 })}
                    options={[
                      { value: '1', label: 'Heading 1' },
                      { value: '2', label: 'Heading 2' },
                      { value: '3', label: 'Heading 3' },
                    ]}
                    disabled={disabled}
                  />
                </div>
              ) : null}
              {b.type === 'table' ? <Switch label="First row is a header" checked={!!b.header} onCheckedChange={(v) => update(b.key, { header: v })} disabled={disabled} /> : null}
              <span className="ml-auto flex items-center gap-0.5">
                <IconButton label={`Move block ${i + 1} up`} icon={<ArrowUp size={14} />} onClick={() => move(i, -1)} disabled={disabled || i === 0} />
                <IconButton label={`Move block ${i + 1} down`} icon={<ArrowDown size={14} />} onClick={() => move(i, 1)} disabled={disabled || i === blocks.length - 1} />
                <IconButton label={`Remove block ${i + 1}`} icon={<Trash size={14} />} onClick={() => onChange(blocks.filter((x) => x.key !== b.key))} disabled={disabled} />
              </span>
            </div>
            {b.type === 'image' ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="Image" required helper="Choose an image from the Library, or upload one below.">
                  <EntitySelect type="asset" filters={{ status: ['image'] }} value={b.assetId ?? null} onChange={(v) => update(b.key, { assetId: v, versionId: undefined })} disabled={disabled} />
                </Field>
                <Field label="Alternative text" required helper="Describes the image for screen readers.">
                  <Input value={b.alt ?? ''} onChange={(e) => update(b.key, { alt: e.target.value })} maxLength={300} disabled={disabled} />
                </Field>
                <Field label="Caption" className="md:col-span-2">
                  <Input value={b.caption ?? ''} onChange={(e) => update(b.key, { caption: e.target.value })} maxLength={500} disabled={disabled} />
                </Field>
                {canUpload && !disabled ? (
                  <div className="md:col-span-2">
                    <FileUploader
                      compact
                      multiple={false}
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      label="Upload Image"
                      workspaceId={workspace.id}
                      purpose="content"
                      target={{ entityType: 'article', entityId: articleId, role: 'attachment' }}
                      onUploaded={(item) => item.assetId && update(b.key, { assetId: item.assetId, versionId: undefined })}
                    />
                  </div>
                ) : null}
              </div>
            ) : b.type === 'file' ? (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="File" required>
                  <EntitySelect type="asset" value={b.assetId ?? null} onChange={(v) => update(b.key, { assetId: v, versionId: undefined })} disabled={disabled} />
                </Field>
                <Field label="Label">
                  <Input value={b.text} onChange={(e) => update(b.key, { text: e.target.value })} maxLength={200} disabled={disabled} />
                </Field>
              </div>
            ) : b.type === 'heading' ? (
              <Input aria-label={`Heading text of block ${i + 1}`} value={b.text} onChange={(e) => update(b.key, { text: e.target.value })} placeholder={PLACEHOLDER.heading} disabled={disabled} className="text-[15px] font-semibold" />
            ) : (
              <Textarea
                aria-label={`${label('richBlock', b.type)} text of block ${i + 1}`}
                value={b.text}
                onChange={(e) => update(b.key, { text: e.target.value })}
                placeholder={PLACEHOLDER[b.type]}
                disabled={disabled}
                className="min-h-[88px] text-[15px] leading-6"
              />
            )}
            <div className="mt-2">{addMenu(i + 1, 'Add Block Below')}</div>
          </li>
        ))}
      </ol>
      <div>{addMenu(blocks.length, blocks.length ? 'Add Block at End' : 'Add First Block')}</div>
    </div>
  );
};
