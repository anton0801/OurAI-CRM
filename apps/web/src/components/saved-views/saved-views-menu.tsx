'use client';
import { BookmarkSimple, Check, UsersThree } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { savedViewEndpoints, type FilterGroupInput, type SavedView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Banner, Button, ConfirmDialog, Dialog, Field, Input, Menu, Switch, type MenuItem } from '@castlane/ui';
import { ConflictDialog } from '@/components/common/conflict';
import { useEditBase } from '@/lib/edit-base';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { useUrlState } from '@/lib/url-state';
import { useWorkspace } from '@/lib/workspace-context';

/** How a URL parameter maps to a typed filter clause: text → contains, list → in, id → equals, flag ('1') → equals true. */
export type ViewParamKind = 'text' | 'list' | 'id' | 'flag';

export interface SavedViewsMenuProps {
  /** Saved view module registered on the server (e.g. 'projects'). */
  module: string;
  /** URL parameter → clause kind. The parameter name is the filter field name. */
  params: Record<string, ViewParamKind>;
  /** URL parameters holding the sort key and direction, when the list is sortable. */
  sort?: { key: string; dir: string };
  /** Called after a view was applied with the URL values it set (e.g. to sync a search box). */
  onApply?: (values: Record<string, string | null>) => void;
}

type Clause = { field: string; operator: 'equals' | 'in' | 'contains'; value: string | boolean | string[] };

const buildAst = (state: Partial<Record<string, string>>, params: Record<string, ViewParamKind>): FilterGroupInput => {
  const clauses: Clause[] = [];
  for (const [key, kind] of Object.entries(params)) {
    const v = state[key];
    if (!v) continue;
    if (kind === 'text') clauses.push({ field: key, operator: 'contains', value: v });
    else if (kind === 'list') {
      const list = v.split(',').filter(Boolean);
      if (list.length) clauses.push({ field: key, operator: 'in', value: list });
    } else if (kind === 'id') clauses.push({ field: key, operator: 'equals', value: v });
    else if (v === '1') clauses.push({ field: key, operator: 'equals', value: true });
  }
  return { op: 'and', clauses };
};

const astToValues = (ast: FilterGroupInput, params: Record<string, ViewParamKind>): Record<string, string | null> => {
  const out: Record<string, string | null> = Object.fromEntries(Object.keys(params).map((k) => [k, null]));
  if (ast.op !== 'and') return out;
  for (const c of ast.clauses) {
    if ('clauses' in c) continue;
    const kind = params[c.field];
    if (!kind) continue;
    if (kind === 'list' && Array.isArray(c.value)) out[c.field] = c.value.map(String).join(',') || null;
    else if (kind === 'flag') out[c.field] = c.value === true ? '1' : null;
    else if (typeof c.value === 'string' || typeof c.value === 'number') out[c.field] = String(c.value);
  }
  return out;
};

const fingerprint = (ast: FilterGroupInput, sort: { key: string; direction: string }[]) => JSON.stringify({ ast, sort });

/**
 * Saved views for a list screen: apply own or shared views, save the current URL filters as a new
 * view, update or delete own views. Views store a typed filter tree, never SQL; every list still
 * applies the member's permissions.
 */
export const SavedViewsMenu = ({ module, params, sort, onApply }: SavedViewsMenuProps) => {
  const { workspace } = useWorkspace();
  const { state, set } = useUrlState<string>();
  const views = useApiQuery(savedViewEndpoints.list, { params: { workspaceId: workspace.id }, query: { module } }, { staleTime: 30_000 });
  const [dialog, setDialog] = useState<null | 'save' | 'manage'>(null);
  const [lastApplied, setLastApplied] = useState<string | null>(null);
  const ast = useMemo(() => buildAst(state, params), [state, params]);
  const currentSort = sort && state[sort.key] ? [{ key: state[sort.key]!, direction: (state[sort.dir] === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc' }] : [];
  const current = fingerprint(ast, currentSort);
  const list = views.data ?? [];
  const active = list.find((v) => fingerprint(v.filterAst, v.sort) === current) ?? null;
  const applied = list.find((v) => v.id === lastApplied) ?? null;
  const invalidate = ['savedViews.list'];
  const update = useApiMutation(savedViewEndpoints.update, { invalidate, successMessage: 'View updated' });

  const apply = (v: SavedView) => {
    const values = astToValues(v.filterAst, params);
    const patch: Record<string, string | null> = { ...values };
    if (sort) {
      patch[sort.key] = v.sort[0]?.key ?? null;
      patch[sort.dir] = v.sort[0]?.direction ?? null;
    }
    set(patch);
    setLastApplied(v.id);
    onApply?.(values);
  };

  const own = list.filter((v) => v.own);
  const shared = list.filter((v) => !v.own);
  const items: MenuItem[] = [
    ...own.map((v) => ({
      label: v.name,
      description: v.shared ? 'Shared with the workspace' : 'Only you',
      icon: active?.id === v.id ? <Check size={14} aria-hidden /> : <span className="inline-block w-[14px]" />,
      onSelect: () => apply(v),
    })),
    ...shared.map((v, i) => ({
      label: v.name,
      description: `Shared by ${v.owner.displayName}`,
      icon: active?.id === v.id ? <Check size={14} aria-hidden /> : <UsersThree size={14} aria-hidden />,
      onSelect: () => apply(v),
      separatorBefore: i === 0 && own.length > 0,
    })),
    { label: 'Save Current View…', onSelect: () => setDialog('save'), separatorBefore: list.length > 0 },
    {
      label: applied ? `Update “${applied.name}”` : 'Update View',
      description: 'Replace its filters with the current ones',
      hidden: !applied || !applied.own || active?.id === applied.id,
      onSelect: () => applied && void update.run({ params: { workspaceId: workspace.id, viewId: applied.id }, body: { filterAst: ast, sort: currentSort } }, { ifMatch: applied.rowVersion }),
    },
    { label: 'Manage Views…', hidden: own.length === 0, onSelect: () => setDialog('manage') },
  ];

  return (
    <>
      <Menu
        label="Saved views"
        align="start"
        trigger={
          <Button size="sm" variant="ghost" icon={<BookmarkSimple size={14} />} aria-label={active ? `Saved views, current: ${active.name}` : 'Saved views'}>
            {active ? active.name : 'Views'}
          </Button>
        }
        items={items}
      />
      {dialog === 'save' ? (
        <SaveViewDialog
          module={module}
          ast={ast}
          sort={currentSort}
          onClose={(v) => {
            setDialog(null);
            if (v) setLastApplied(v.id);
          }}
        />
      ) : null}
      {dialog === 'manage' ? <ManageViewsDialog views={own} onClose={() => setDialog(null)} /> : null}
    </>
  );
};

const SaveViewDialog = ({ module, ast, sort, onClose }: { module: string; ast: FilterGroupInput; sort: { key: string; direction: 'asc' | 'desc' }[]; onClose: (v?: SavedView) => void }) => {
  const { workspace } = useWorkspace();
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = useApiMutation(savedViewEndpoints.create, { invalidate: ['savedViews.list'], silentErrors: true, successMessage: 'View saved' });
  const submit = async () => {
    setError(null);
    try {
      onClose(await create.run({ params: { workspaceId: workspace.id }, body: { module, name: name.trim(), filterAst: ast, sort, columns: [], shared } }));
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'Could not save the view.');
    }
  };
  return (
    <Dialog
      open
      size="small"
      onOpenChange={(o) => !o && onClose()}
      title="Save current view"
      description={`${ast.clauses.length} filter${ast.clauses.length === 1 ? '' : 's'}${sort.length ? ' and the current sort' : ''}. Everyone still sees only the records they may access.`}
      footer={
        <>
          <Button onClick={() => onClose()}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={name.trim().length < 2} onClick={() => void submit()}>
            Save View
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
        </Field>
        <Switch label="Share with the workspace" description="Others can apply it; only you can change it." checked={shared} onCheckedChange={setShared} />
      </div>
    </Dialog>
  );
};

/** One saved view: the name is renamed against the version it had when typing started (T162). */
const ManagedView = ({ v, onDelete }: { v: SavedView; onDelete: () => void }) => {
  const { workspace } = useWorkspace();
  const update = useApiMutation(savedViewEndpoints.update, { invalidate: ['savedViews.list'] });
  const [name, setName] = useState<string | null>(null);
  const typing = name !== null;
  const edit = useEditBase(v, { open: typing, onReload: (latest) => setName(latest.name) });
  const params = { workspaceId: workspace.id, viewId: v.id };
  const shown = name ?? v.name;
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line p-2">
      <Input className="min-w-[160px] flex-1" aria-label={`Name of ${v.name}`} value={shown} maxLength={120} onChange={(e) => setName(e.target.value)} />
      {typing && shown.trim() !== (edit.start ?? v).name ? (
        <Button
          size="sm"
          disabled={shown.trim().length < 2}
          onClick={() =>
            void update.run({ params, body: { name: shown.trim() } }, { ifMatch: edit.version }).then(
              () => setName(null),
              (e: unknown) => edit.catchConflict(e),
            )
          }
        >
          Rename
        </Button>
      ) : null}
      <Switch label="Shared" checked={v.shared} onCheckedChange={(s) => void update.run({ params, body: { shared: s } }, { ifMatch: v.rowVersion })} />
      <Button size="sm" variant="ghost" onClick={onDelete}>
        Delete
      </Button>
      <ConflictDialog {...edit.conflictDialog} />
    </li>
  );
};

const ManageViewsDialog = ({ views, onClose }: { views: SavedView[]; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const invalidate = ['savedViews.list'];
  const remove = useApiMutation(savedViewEndpoints.remove, { invalidate, successMessage: 'View deleted' });
  const [deleting, setDeleting] = useState<SavedView | null>(null);
  const params = (v: SavedView) => ({ workspaceId: workspace.id, viewId: v.id });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Manage saved views" footer={<Button onClick={onClose}>Done</Button>}>
      <ul className="flex flex-col gap-3">
        {views.map((v) => (
          <ManagedView key={v.id} v={v} onDelete={() => setDeleting(v)} />
        ))}
      </ul>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        body={deleting?.shared ? 'Others who use this shared view will no longer see it. No records are affected.' : 'Only the saved filters are deleted. No records are affected.'}
        confirmLabel="Delete View"
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting && void remove.run({ params: params(deleting) }, { ifMatch: deleting.rowVersion }).then(() => setDeleting(null), () => undefined)}
      />
    </Dialog>
  );
};
