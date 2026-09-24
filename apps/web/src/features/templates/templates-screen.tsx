'use client';
import { Plus, Stack } from '@phosphor-icons/react';
import { useState } from 'react';
import { templateEndpoints, type TemplateSummary } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { TEMPLATE_KINDS } from '@castlane/domain';
import { Badge, Banner, Button, DataTable, Drawer, EmptyState, Field, Input, NoResults, PageHeader, RadioGroup, Select, StatusBadge, Switch, Tabs, Textarea, Toolbar, formatDateTime, type Column } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useDebounced } from '@/components/common/use-debounced';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace } from '@/lib/workspace-context';
import { CustomFieldsSettings } from '../custom-fields/fields-settings';
import { TemplateEditor } from './template-editor';
import '../inbox/labels';

type Filters = 'tab' | 'kind' | 'disabled' | 'open';
type Kind = TemplateSummary['kind'];
const KIND_HELP: Record<Kind, string> = {
  task: 'A dated task plan with dependencies, estimates and checklists.',
  content: 'Format, deliverable slots, checklist and production tasks for a content item.',
  checklist: 'A reusable checklist, for example a publishing or release checklist.',
  quality_rubric: 'Weighted quality criteria (weights add up to 100) for reviews.',
};

/** S72 Templates & Custom Fields (Settings). */
export const TemplatesScreen = () => {
  const { state, set } = useUrlState<Filters>();
  const tab = state.tab === 'fields' ? 'fields' : 'templates';
  if (tab === 'templates' && state.open) return <TemplateEditor templateId={state.open} />;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Templates & Custom Fields" crumbs={[{ label: 'Settings' }, { label: 'Templates & Custom Fields' }]} description="Reusable plans, checklists and rubrics with versions, and the extra fields your team tracks on records." />
      <Tabs
        label="Templates and custom fields"
        value={tab}
        onValueChange={(v) => set({ tab: v === 'fields' ? 'fields' : null, open: null, kind: null, disabled: null })}
        items={[
          { value: 'templates', label: 'Templates' },
          { value: 'fields', label: 'Custom Fields' },
        ]}
      />
      {tab === 'templates' ? <TemplateList /> : <CustomFieldsSettings openId={state.open ?? null} onOpen={(id) => set({ open: id })} />}
    </div>
  );
};

const TemplateList = () => {
  const { workspace, user } = useWorkspace();
  const can = useCan();
  const { state, set } = useUrlState<Filters>();
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 250);
  const [creating, setCreating] = useState(false);
  const list = useApiQuery(templateEndpoints.list, { params: { workspaceId: workspace.id }, query: { kind: (state.kind as Kind) || undefined, includeDisabled: state.disabled === '1' || undefined, q: debounced || undefined } });
  const open = (id: string) => set({ open: id });
  const columns: Column<TemplateSummary>[] = [
    {
      key: 'name',
      header: 'Template',
      sticky: true,
      minWidth: 240,
      cell: (t) => (
        <span className="flex flex-col">
          <span className="font-medium text-fg">{t.name}</span>
          {t.description ? <span className="line-clamp-1 text-[12px] text-fg-2">{t.description}</span> : null}
        </span>
      ),
    },
    { key: 'kind', header: 'Kind', minWidth: 130, cell: (t) => <Badge>{label('templateKind', t.kind)}</Badge> },
    { key: 'status', header: 'Status', minWidth: 120, cell: (t) => <StatusBadge status={t.status === 'published' ? 'active' : t.status === 'disabled' ? 'archived' : 'draft'} label={label('templateStatus', t.status)} /> },
    {
      key: 'version',
      header: 'Version',
      minWidth: 170,
      cell: (t) => (
        <span className="text-[13px]">
          {t.publishedVersion ? `v${t.publishedVersion.versionNo} published` : 'Not published'}
          {t.draftVersion ? <span className="text-fg-2"> · v{t.draftVersion.versionNo} draft</span> : null}
        </span>
      ),
    },
    { key: 'updated', header: 'Updated', minWidth: 160, cell: (t) => formatDateTime(t.updatedAt, user.timezone) },
  ];
  const filtered = !!(state.kind || debounced || state.disabled);
  return (
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full sm:w-[240px]">
          <Input type="search" aria-label="Search templates" placeholder="Search templates" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="w-full sm:w-[190px]">
          <Select aria-label="Kind" value={state.kind ?? null} onChange={(v) => set({ kind: v })} clearable placeholder="All kinds" options={TEMPLATE_KINDS.map((k) => ({ value: k, label: label('templateKind', k) }))} />
        </div>
        <Switch label="Show disabled" checked={state.disabled === '1'} onCheckedChange={(v) => set({ disabled: v ? '1' : null })} />
        {can('templates.manage') ? (
          <Button className="ml-auto" variant="primary" icon={<Plus size={14} weight="bold" />} onClick={() => setCreating(true)}>
            New Template
          </Button>
        ) : null}
      </Toolbar>
      <QueryState query={list}>
        <DataTable
          caption="Templates"
          rows={list.data ?? []}
          columns={columns}
          getRowId={(t) => t.id}
          density={user.density}
          onRowClick={(t) => open(t.id)}
          empty={
            filtered ? (
              <NoResults
                onClear={() => {
                  setQ('');
                  set({ kind: null, disabled: null });
                }}
              />
            ) : (
              <EmptyState icon={<Stack size={28} />} title="No templates yet" description="Create a template for work your team repeats, then publish it so it can be applied." />
            )
          }
        />
      </QueryState>
      {creating ? <NewTemplateDrawer initialKind={(state.kind as Kind) || 'task'} onClose={() => setCreating(false)} onCreated={open} /> : null}
    </div>
  );
};

const NewTemplateDrawer = ({ initialKind, onClose, onCreated }: { initialKind: Kind; onClose: () => void; onCreated: (id: string) => void }) => {
  const { workspace } = useWorkspace();
  const [kind, setKind] = useState<Kind>(initialKind);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useApiMutation(templateEndpoints.create, { invalidate: ['templates.list'], silentErrors: true, successMessage: 'Template created as a draft' });
  const submit = async () => {
    setError(null);
    try {
      const t = await create.run({ params: { workspaceId: workspace.id }, body: { kind, name: name.trim(), description: description.trim() || null } });
      onClose();
      onCreated(t.id);
    } catch (e) {
      setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'Could not create the template.');
    }
  };
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      title="New Template"
      description="It starts as draft version 1. Publish it when it is ready to be applied."
      dirty={!!(name || description)}
      footer={
        <>
          <Button onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={name.trim().length < 2} onClick={() => void submit()}>
            Create Draft
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <RadioGroup label="Kind" value={kind} onValueChange={setKind} options={TEMPLATE_KINDS.map((k) => ({ value: k, label: label('templateKind', k), description: KIND_HELP[k] }))} />
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={2000} />
        </Field>
      </div>
    </Drawer>
  );
};
