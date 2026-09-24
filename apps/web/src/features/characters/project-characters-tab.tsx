'use client';
import { Plus, Star, UserCircle } from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { characterEndpoints, type ProjectDetail } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { Badge, Banner, Button, Checkbox, Dialog, EmptyState, Field, Input, StatusBadge, Switch, TableSkeleton } from '@castlane/ui';
import { QueryState } from '@/components/common/query-state';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import '@/features/accounts/labels';

/** Project workspace tab "Characters" (S16 entry point): identities with their approved profile version. */
export const ProjectCharactersTab = ({ project }: { project: ProjectDetail }) => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [primary, setPrimary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useApiQuery(characterEndpoints.list, { params: { workspaceId: workspace.id, projectId: project.id }, query: { includeArchived: showArchived || undefined } });
  const create = useApiMutation(characterEndpoints.create, { invalidate: ['characters.', 'projects.get'], silentErrors: true, successMessage: 'Character created' });
  const canWrite = can('characters.write') && project.status !== 'archived';
  const hasPrimary = (q.data ?? []).some((c) => c.isPrimary && !c.archivedAt);
  const openCreate = () => {
    setName('');
    setRole('');
    setPrimary(project.type !== 'series' && !hasPrimary);
    setError(null);
    setOpen(true);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-fg-2">
          Profiles are versioned: approved versions never change, and content refers to the version it was made with.
          {project.type !== 'series' ? ' One character is the project’s primary identity.' : ''}
        </p>
        <div className="flex items-center gap-3">
          <Switch label="Show archived" checked={showArchived} onCheckedChange={setShowArchived} />
          {canWrite ? (
            <Button icon={<Plus size={14} />} onClick={openCreate}>
              New Character
            </Button>
          ) : null}
        </div>
      </div>
      <QueryState query={q} skeleton={<TableSkeleton rows={3} columns={4} />}>
        {(q.data ?? []).length === 0 ? (
          <EmptyState
            icon={<UserCircle size={28} />}
            title="No characters yet"
            description={canWrite ? 'Create a character profile to keep appearance, voice and prompts consistent across content.' : 'No character profiles are shared with you in this project.'}
            action={canWrite ? <Button variant="primary" onClick={openCreate}>New Character</Button> : undefined}
          />
        ) : (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {(q.data ?? []).map((c) => (
              <li key={c.id}>
                <Link href={wsPath(`/projects/${project.id}/characters/${c.id}`)} className="flex gap-3 rounded-[12px] border border-line bg-surface p-3 hover:border-fg-muted">
                  {c.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.thumbnailUrl} alt="" width={72} height={96} className="h-24 w-[72px] shrink-0 rounded-[8px] bg-surface-2 object-cover" loading="lazy" />
                  ) : (
                    <span aria-hidden className="flex h-24 w-[72px] shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-[18px] font-semibold text-fg-muted">
                      {c.name.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex items-center gap-2 font-semibold text-fg">
                      <span className="truncate">{c.name}</span>
                      {c.isPrimary ? (
                        <Badge tone="primary" icon={<Star size={12} weight="fill" aria-hidden />}>
                          Primary
                        </Badge>
                      ) : null}
                    </span>
                    {c.role ? <span className="truncate text-[13px] text-fg-2">{c.role}</span> : null}
                    <span className="flex flex-wrap gap-1.5">
                      {c.approvedVersion ? <StatusBadge status="approved" label={`Approved v${c.approvedVersion.versionNo}`} /> : <Badge>No approved version</Badge>}
                      {c.openVersion ? <StatusBadge status={c.openVersion.state} label={`v${c.openVersion.versionNo} ${label('characterVersionState', c.openVersion.state)}`} /> : null}
                      {c.archivedAt ? <StatusBadge status="archived" /> : null}
                    </span>
                    <span className="text-[12px] text-fg-2">{c.referenceCount} reference image(s)</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        dirty={!!name || !!role}
        title="New character"
        size="small"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={name.trim().length < 2}
              loading={create.isPending}
              onClick={async () => {
                setError(null);
                try {
                  const c = await create.run({ params: { workspaceId: workspace.id, projectId: project.id }, body: { name: name.trim(), role: role.trim() || null, isPrimary: project.type !== 'series' ? primary : undefined } });
                  setOpen(false);
                  router.push(wsPath(`/projects/${project.id}/characters/${c.id}`));
                } catch (e) {
                  setError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The character could not be created.');
                }
              }}
            >
              Create Character
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Role" helper="E.g. Lead, Host, Antagonist.">
            <Input value={role} onChange={(e) => setRole(e.target.value)} maxLength={120} />
          </Field>
          {project.type !== 'series' ? (
            <Checkbox checked={primary} onCheckedChange={setPrimary} label="Primary character" description={hasPrimary ? 'The current primary character is unmarked.' : 'The project’s main identity.'} />
          ) : null}
        </div>
      </Dialog>
    </div>
  );
};
