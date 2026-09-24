'use client';
import { ArrowDown, ArrowUp, PencilSimple } from '@phosphor-icons/react';
import { useState } from 'react';
import { knowledgeEndpoints, type CategoryView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Badge, Banner, Button, Dialog, Field, IconButton, Input } from '@castlane/ui';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { useWorkspace } from '@/lib/workspace-context';

/** Manage Category (S38): create, rename, reorder, archive and restore categories. */
export const CategoryDialog = ({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) => {
  const { workspace } = useWorkspace();
  const q = useApiQuery(knowledgeEndpoints.listCategories, { params: { workspaceId: workspace.id }, query: { includeArchived: true } }, { enabled: open });
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inv = { invalidate: ['knowledge.'], silentErrors: true };
  const create = useApiMutation(knowledgeEndpoints.createCategory, { ...inv, successMessage: 'Category created' });
  const update = useApiMutation(knowledgeEndpoints.updateCategory, { ...inv, successMessage: 'Category saved' });
  const archive = useApiMutation(knowledgeEndpoints.archiveCategory, { ...inv, successMessage: 'Category archived' });
  const restore = useApiMutation(knowledgeEndpoints.restoreCategory, { ...inv, successMessage: 'Category restored' });
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The change could not be saved.');
      return false;
    }
  };
  const active = (q.data?.items ?? []).filter((c) => !c.archivedAt);
  const archived = (q.data?.items ?? []).filter((c) => c.archivedAt);
  const move = (c: CategoryView, d: -1 | 1) => {
    const i = active.findIndex((x) => x.id === c.id);
    const other = active[i + d];
    if (!other) return;
    void run(async () => {
      // Positions are compacted to the list order; swapping two neighbours needs two saves.
      await update.run({ params: { workspaceId: workspace.id, categoryId: c.id }, body: { sortOrder: (i + d) * 10 } }, { ifMatch: c.rowVersion });
      await update.run({ params: { workspaceId: workspace.id, categoryId: other.id }, body: { sortOrder: i * 10 } }, { ifMatch: other.rowVersion });
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Manage Categories" description="Archived categories stay on their articles for history but are not offered for new articles." footer={<Button onClick={() => onOpenChange(false)}>Done</Button>}>
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim().length < 2) return;
            void run(() => create.run({ params: { workspaceId: workspace.id }, body: { name: name.trim(), sortOrder: active.length * 10 } })).then((ok) => ok && setName(''));
          }}
        >
          <Field label="New category" className="flex-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={name.trim().length < 2}>
            Add
          </Button>
        </form>
        <ul className="flex flex-col divide-y divide-line rounded-[8px] border border-line">
          {active.map((c, i) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              {editing?.id === c.id ? (
                <form
                  className="flex flex-1 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(() => update.run({ params: { workspaceId: workspace.id, categoryId: c.id }, body: { name: editing.name.trim() } }, { ifMatch: c.rowVersion })).then((ok) => ok && setEditing(null));
                  }}
                >
                  <Input aria-label="Category name" value={editing.name} onChange={(e) => setEditing({ id: c.id, name: e.target.value })} maxLength={120} autoFocus />
                  <Button size="sm" type="submit" variant="primary" loading={update.isPending}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-[14px] text-fg">{c.name}</span>
                  <Badge>{c.articleCount} article{c.articleCount === 1 ? '' : 's'}</Badge>
                  <IconButton label={`Move ${c.name} up`} icon={<ArrowUp size={14} />} disabled={i === 0} onClick={() => move(c, -1)} />
                  <IconButton label={`Move ${c.name} down`} icon={<ArrowDown size={14} />} disabled={i === active.length - 1} onClick={() => move(c, 1)} />
                  <IconButton label={`Rename ${c.name}`} icon={<PencilSimple size={14} />} onClick={() => setEditing({ id: c.id, name: c.name })} />
                  <Button size="sm" variant="ghost" onClick={() => void run(() => archive.run({ params: { workspaceId: workspace.id, categoryId: c.id }, body: {} }, { ifMatch: c.rowVersion }))}>
                    Archive
                  </Button>
                </>
              )}
            </li>
          ))}
          {!active.length ? <li className="px-3 py-3 text-[13px] text-fg-2">No categories yet. Add one to start writing articles.</li> : null}
        </ul>
        {archived.length ? (
          <section className="flex flex-col gap-2">
            <h3 className="text-[13px] font-semibold text-fg-2">Archived</h3>
            <ul className="flex flex-col divide-y divide-line rounded-[8px] border border-line">
              {archived.map((c) => (
                <li key={c.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-[14px] text-fg-2">{c.name}</span>
                  <Button size="sm" variant="ghost" onClick={() => void run(() => restore.run({ params: { workspaceId: workspace.id, categoryId: c.id }, body: {} }, { ifMatch: c.rowVersion }))}>
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Dialog>
  );
};
