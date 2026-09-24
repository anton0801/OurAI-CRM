'use client';
import { CheckSquare, File, ListChecks } from '@phosphor-icons/react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { RichBlock, RichInline, RichTextDocument } from '@castlane/api-contracts';
import { isSafeUrl } from '@castlane/domain';
import { Button } from '@castlane/ui';
import { useWorkspace, useWsPath } from '@/lib/workspace-context';

const Inline = ({ runs }: { runs: RichInline[] }) => (
  <>
    {runs.map((r, i) => {
      let node: ReactNode = r.text;
      if (r.marks?.includes('code')) node = <code className="rounded-[4px] bg-surface-2 px-1 font-mono text-[0.9em]">{node}</code>;
      if (r.marks?.includes('italic')) node = <em>{node}</em>;
      if (r.marks?.includes('bold')) node = <strong className="font-semibold">{node}</strong>;
      // Links open outside the app without passing the opener or referrer (safe links, §23.3).
      if (r.href && isSafeUrl(r.href))
        node = (
          <a href={r.href} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline underline-offset-2">
            {node}
          </a>
        );
      return <span key={i}>{node}</span>;
    })}
  </>
);

/**
 * Renders a structured article (headings 1–3, paragraphs, lists, checklists, tables, quotes,
 * safe links, images and files). No HTML from users is ever rendered; images come from the
 * authorised derivative endpoint, max 760 px wide, lazily loaded.
 */
export const RichTextView = ({
  doc,
  onCreateTask,
}: {
  doc: RichTextDocument;
  /** Offered next to each checklist when the member may create tasks. */
  onCreateTask?: (blockIndex: number) => void;
}) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  if (!doc.content.length) return <p className="text-[15px] leading-6 text-fg-2">This version has no text yet.</p>;
  const block = (b: RichBlock, i: number) => {
    switch (b.type) {
      case 'heading': {
        const cls = b.level === 1 ? 'text-[22px] leading-8 font-[650] mt-2' : b.level === 2 ? 'text-[18px] leading-[26px] font-semibold mt-2' : 'text-[16px] leading-6 font-semibold';
        const Tag = b.level === 1 ? 'h2' : b.level === 2 ? 'h3' : 'h4';
        return (
          <Tag key={i} className={`text-fg ${cls}`}>
            <Inline runs={b.content} />
          </Tag>
        );
      }
      case 'paragraph':
        return (
          <p key={i} className="whitespace-pre-wrap text-[15px] leading-6 text-fg">
            <Inline runs={b.content} />
          </p>
        );
      case 'quote':
        return (
          <blockquote key={i} className="border-l-2 border-line pl-4 text-[15px] leading-6 text-fg-2">
            <Inline runs={b.content} />
          </blockquote>
        );
      case 'bullet_list':
        return (
          <ul key={i} className="list-disc pl-6 text-[15px] leading-6 text-fg">
            {b.items.map((it, j) => (
              <li key={j}>
                <Inline runs={it} />
              </li>
            ))}
          </ul>
        );
      case 'ordered_list':
        return (
          <ol key={i} className="list-decimal pl-6 text-[15px] leading-6 text-fg">
            {b.items.map((it, j) => (
              <li key={j}>
                <Inline runs={it} />
              </li>
            ))}
          </ol>
        );
      case 'checklist':
        return (
          <div key={i} className="flex flex-col gap-2 rounded-[8px] border border-line p-3">
            <ul className="flex flex-col gap-1.5 text-[15px] leading-6 text-fg" aria-label="Checklist">
              {b.items.map((it) => (
                <li key={it.id} className="flex items-start gap-2">
                  <CheckSquare size={18} className="mt-[3px] shrink-0 text-fg-2" aria-hidden />
                  <span>
                    <Inline runs={it.content} />
                  </span>
                </li>
              ))}
            </ul>
            {onCreateTask ? (
              <div>
                <Button size="sm" icon={<ListChecks size={14} />} onClick={() => onCreateTask(i)}>
                  Create Task from Checklist
                </Button>
              </div>
            ) : null}
          </div>
        );
      case 'table':
        return (
          <div key={i} className="overflow-x-auto rounded-[8px] border border-line" role="region" aria-label="Table" tabIndex={0}>
            <table className="w-full border-collapse text-left text-[14px] leading-[22px]">
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r} className="border-b border-line last:border-b-0">
                    {row.map((cell, c) =>
                      b.header && r === 0 ? (
                        <th key={c} scope="col" className="bg-surface-2 px-3 py-2 font-semibold text-fg">
                          <Inline runs={cell} />
                        </th>
                      ) : (
                        <td key={c} className="px-3 py-2 align-top text-fg">
                          <Inline runs={cell} />
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      case 'image':
        return (
          <figure key={i} className="flex max-w-[760px] flex-col gap-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/v1/workspaces/${workspace.id}/assets/${b.assetId}/thumbnail?size=1280${b.versionId ? `&versionId=${b.versionId}` : ''}`}
              alt={b.alt}
              loading="lazy"
              className="max-w-full rounded-[8px] bg-surface-2 object-contain"
            />
            {b.caption ? <figcaption className="text-[13px] text-fg-2">{b.caption}</figcaption> : null}
          </figure>
        );
      case 'file':
        return (
          <p key={i}>
            <Link href={wsPath(`/library/assets/${b.assetId}`)} className="inline-flex items-center gap-2 rounded-[8px] border border-line px-3 py-2 text-[14px] text-fg hover:bg-surface-2">
              <File size={16} aria-hidden /> {b.label || 'Attached file'}
            </Link>
          </p>
        );
    }
  };
  return <div className="flex max-w-[760px] flex-col gap-4">{doc.content.map(block)}</div>;
};
