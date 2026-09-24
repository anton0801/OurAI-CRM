'use client';
import { ArrowDown, ArrowUp, DotsThree, FilmSlate, Plus, Trash } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { characterEndpoints, seriesEndpoints, type SceneView, type SeasonView } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { CONTENT_FORMATS, LIMITS } from '@castlane/domain';
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  IconButton,
  Input,
  Menu,
  MultiSelect,
  PageHeader,
  Panel,
  Select,
  StatusBadge,
  Switch,
  Textarea,
  toast,
  type MenuItem,
} from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { ConflictDialog } from '@/components/common/conflict';
import { QueryState } from '@/components/common/query-state';
import { AssetThumb, FileUploader } from '@/components/media/file-uploader';
import { useApiMutation, useApiQuery } from '@/lib/hooks';
import { changedFields, pickChanged, useEditBase } from '@/lib/edit-base';
import { label } from '@/lib/labels';
import { EPISODE_PANELS } from '@/lib/slots';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import '@/features/slots';
import '@/features/accounts/labels';
import { ApplyTemplateDialog, type TemplateTarget } from '@/features/tasks/apply-template-dialog';

const fmtSeconds = (s: number | null) => (s === null ? '—' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);

const errorText = (e: unknown, fallback: string) =>
  isApiError(e) ? (e.code === 'VERSION_CONFLICT' ? 'This record changed while you were editing it. Compare changes before saving.' : (e.fieldErrors[0]?.message ?? e.message)) : fallback;

/**
 * S17 Series Structure: seasons → episodes → scenes. Reordering uses Move Up / Move Down buttons
 * (keyboard accessible); ids never change. Used as a page and as the project "Series" tab.
 */
export const SeriesStructure = ({ projectId, embedded = false }: { projectId: string; embedded?: boolean }) => {
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const { state, set } = useUrlState<'episode' | 'archived'>({});
  const includeArchived = state.archived === '1';
  const q = useApiQuery(seriesEndpoints.structure, { params: { workspaceId: workspace.id, projectId }, query: { includeArchived: includeArchived || undefined } });
  const [seasonOpen, setSeasonOpen] = useState(false);
  const [seasonName, setSeasonName] = useState('');
  const [seasonError, setSeasonError] = useState<string | null>(null);
  const createSeason = useApiMutation(seriesEndpoints.createSeason, { invalidate: ['series.', 'projects.get'], silentErrors: true, successMessage: 'Season added' });

  return (
    <QueryState query={q}>
      {q.data ? (
        <div className="flex flex-col gap-5">
          {!embedded ? (
            <PageHeader
              crumbs={[{ label: 'Projects', href: wsPath('/projects') }, { label: q.data.project.name, href: wsPath(`/projects/${projectId}`) }, { label: 'Series' }]}
              title="Series Structure"
              description="Seasons, episodes and scenes. Exports never publish to external platforms."
            />
          ) : null}
          {q.data.project.type !== 'series' ? (
            <EmptyState icon={<FilmSlate size={28} />} title="Not a series project" description="Seasons, episodes and scenes exist only in Series projects." />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Switch label="Show archived" checked={includeArchived} onCheckedChange={(v) => set({ archived: v ? '1' : null })} />
                {q.data.permissions.write ? (
                  <Button
                    icon={<Plus size={14} />}
                    onClick={() => {
                      setSeasonName(`Season ${q.data!.seasons.filter((s) => !s.archivedAt).length + 1}`);
                      setSeasonError(null);
                      setSeasonOpen(true);
                    }}
                  >
                    Add Season
                  </Button>
                ) : null}
              </div>
              {q.data.seasons.length === 0 ? (
                <EmptyState
                  icon={<FilmSlate size={28} />}
                  title="No seasons yet"
                  description={q.data.permissions.write ? 'Add a season, then its episodes and scenes.' : 'No seasons have been added to this series yet.'}
                  action={q.data.permissions.write ? <Button variant="primary" onClick={() => setSeasonOpen(true)}>Add Season</Button> : undefined}
                />
              ) : (
                q.data.seasons.map((s, i, arr) => (
                  <SeasonPanel
                    key={s.id}
                    season={s}
                    canWrite={q.data!.permissions.write}
                    first={i === 0 || !!s.archivedAt}
                    last={i === arr.filter((x) => !x.archivedAt).length - 1 || !!s.archivedAt}
                    onOpenEpisode={(id) => set({ episode: id }, { replace: false })}
                  />
                ))
              )}
            </>
          )}
          <Dialog
            open={seasonOpen}
            onOpenChange={setSeasonOpen}
            title="Add season"
            size="small"
            footer={
              <>
                <Button onClick={() => setSeasonOpen(false)}>Cancel</Button>
                <Button
                  variant="primary"
                  disabled={seasonName.trim().length < 2}
                  loading={createSeason.isPending}
                  onClick={async () => {
                    try {
                      await createSeason.run({ params: { workspaceId: workspace.id, projectId }, body: { name: seasonName.trim() } });
                      setSeasonOpen(false);
                    } catch (e) {
                      setSeasonError(errorText(e, 'The season could not be added.'));
                    }
                  }}
                >
                  Add Season
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              {seasonError ? <Banner tone="danger">{seasonError}</Banner> : null}
              <Field label="Season name" required>
                <Input value={seasonName} onChange={(e) => setSeasonName(e.target.value)} maxLength={120} />
              </Field>
            </div>
          </Dialog>
          {state.episode ? <EpisodeDrawer episodeId={state.episode} projectId={projectId} onClose={() => set({ episode: null })} /> : null}
        </div>
      ) : null}
    </QueryState>
  );
};

const SeasonPanel = ({ season: s, canWrite, first, last, onOpenEpisode }: { season: SeasonView; canWrite: boolean; first: boolean; last: boolean; onOpenEpisode: (id: string) => void }) => {
  const canCreateTasks = useCan()('tasks.create');
  const [taskTarget, setTaskTarget] = useState<TemplateTarget | null>(null);
  const { workspace } = useWorkspace();
  const wsPath = useWsPath();
  const move = useApiMutation(seriesEndpoints.moveSeason, { invalidate: ['series.'] });
  const rename = useApiMutation(seriesEndpoints.updateSeason, { invalidate: ['series.'], silentErrors: true, successMessage: 'Season renamed' });
  const archive = useApiMutation(seriesEndpoints.archiveSeason, { invalidate: ['series.'], successMessage: 'Season archived' });
  const restore = useApiMutation(seriesEndpoints.restoreSeason, { invalidate: ['series.'], successMessage: 'Season restored' });
  const [renameOpen, setRenameOpen] = useState(false);
  const [name, setName] = useState(s.name);
  const renameBase = useEditBase(s, { open: renameOpen, onReload: (latest) => setName(latest.name) });
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [episodeOpen, setEpisodeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archived = !!s.archivedAt;
  const menu: MenuItem[] = [
    { label: 'Rename', onSelect: () => { setName(s.name); setError(null); setRenameOpen(true); }, hidden: archived },
    { label: 'Archive Season', destructive: true, onSelect: () => setArchiveOpen(true), hidden: archived },
    { label: 'Restore Season', onSelect: () => void restore.run({ params: { workspaceId: workspace.id, seasonId: s.id }, body: {} }, { ifMatch: s.rowVersion }).catch(() => undefined), hidden: !archived },
  ];
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          {s.name}
          {archived ? <StatusBadge status="archived" /> : null}
        </span>
      }
      description={`${s.episodes.length} episode(s)`}
      actions={
        canWrite ? (
          <>
            {!archived ? (
              <>
                <IconButton label={`Move ${s.name} up`} icon={<ArrowUp size={16} />} disabled={first || move.isPending} onClick={() => void move.run({ params: { workspaceId: workspace.id, seasonId: s.id }, body: { direction: 'up' } }, { ifMatch: s.rowVersion }).catch(() => undefined)} />
                <IconButton label={`Move ${s.name} down`} icon={<ArrowDown size={16} />} disabled={last || move.isPending} onClick={() => void move.run({ params: { workspaceId: workspace.id, seasonId: s.id }, body: { direction: 'down' } }, { ifMatch: s.rowVersion }).catch(() => undefined)} />
                <Button size="sm" icon={<Plus size={12} />} onClick={() => setEpisodeOpen(true)}>
                  Add Episode
                </Button>
              </>
            ) : null}
            <Menu label={`${s.name} actions`} trigger={<IconButton label={`${s.name} actions`} icon={<DotsThree size={18} weight="bold" />} />} items={menu} />
          </>
        ) : undefined
      }
      bodyClassName="p-0"
    >
      {s.episodes.length === 0 ? (
        <p className="p-4 text-[14px] text-fg-2">No episodes yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {s.episodes.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              {e.thumbnailAssetId ? <AssetThumb workspaceId={workspace.id} assetId={e.thumbnailAssetId} size={128} alt="" className="h-9 w-16 object-cover" /> : <span aria-hidden className="h-9 w-16 rounded-[8px] bg-surface-2" />}
              <button type="button" className="min-w-0 flex-1 text-left hover:underline focus-visible:outline-2 focus-visible:outline-[var(--c-focus)]" onClick={() => onOpenEpisode(e.id)}>
                <span className="font-medium text-fg">
                  {e.number}. {e.title}
                </span>
                <span className="ml-2 text-[12px] text-fg-2">
                  {e.language.toUpperCase()} · {e.sceneCount} scene(s){e.targetDurationSeconds ? ` · ${fmtSeconds(e.targetDurationSeconds)}` : ''}
                </span>
              </button>
              {e.archivedAt ? <StatusBadge status="archived" /> : null}
              {e.contentItem && canCreateTasks && !e.archivedAt ? (
                <Button size="sm" onClick={() => setTaskTarget({ type: 'content_item', id: e.contentItem!.id, label: `${e.number}. ${e.title}` })}>
                  Generate Production Tasks
                </Button>
              ) : null}
              {e.contentItem ? (
                <Link href={wsPath(`/content/${e.contentItem.id}`)} className="text-[13px] text-primary hover:underline">
                  Open Content
                </Link>
              ) : canWrite && !e.archivedAt ? (
                <span className="text-[12px] text-fg-2">Link the episode’s content to generate production tasks.</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title="Rename season"
        size="small"
        footer={
          <>
            <Button onClick={() => setRenameOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={name.trim().length < 2}
              loading={rename.isPending}
              onClick={async () => {
                try {
                  await rename.run({ params: { workspaceId: workspace.id, seasonId: s.id }, body: { name: name.trim() } }, { ifMatch: renameBase.version });
                  setRenameOpen(false);
                } catch (e) {
                  if (!renameBase.catchConflict(e)) setError(errorText(e, 'The season could not be renamed.'));
                }
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <Field label="Season name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </Field>
        </div>
      </Dialog>
      <ConflictDialog {...renameBase.conflictDialog} />
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archive season?"
        body={`${s.episodes.length} episode(s) and their scenes are archived with the season. Nothing is deleted; publications keep their links.`}
        confirmLabel="Archive Season"
        destructive
        loading={archive.isPending}
        onConfirm={async () => {
          try {
            await archive.run({ params: { workspaceId: workspace.id, seasonId: s.id }, body: {} }, { ifMatch: s.rowVersion });
            setArchiveOpen(false);
          } catch {
            /* toast shown */
          }
        }}
      />
      <ApplyTemplateDialog open={!!taskTarget} onOpenChange={(o) => !o && setTaskTarget(null)} projectId={s.projectId} target={taskTarget ?? undefined} />
      {episodeOpen ? <EpisodeFormDialog seasonId={s.id} projectId={s.projectId} onClose={() => setEpisodeOpen(false)} nextNumber={Math.max(0, ...s.episodes.map((e) => e.number)) + 1} /> : null}
    </Panel>
  );
};

type EpisodeFormState = { number: string; title: string; synopsis: string; duration: string; language: string; contentItemId: string | null; thumbnailAssetId: string | null };

const EpisodeFields = ({ value, onChange, projectId, errors }: { value: EpisodeFormState; onChange: (v: EpisodeFormState) => void; projectId: string; errors: Record<string, string> }) => {
  const { workspace } = useWorkspace();
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Episode number" required error={errors.number}>
        <Input value={value.number} onChange={(e) => onChange({ ...value, number: e.target.value })} inputMode="numeric" />
      </Field>
      <Field label="Language" required error={errors.language} helper="Language code, e.g. en.">
        <Input value={value.language} onChange={(e) => onChange({ ...value, language: e.target.value })} maxLength={20} />
      </Field>
      <Field label="Title" required error={errors.title} className="sm:col-span-2">
        <Input value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} maxLength={120} />
      </Field>
      <Field label="Synopsis" className="sm:col-span-2" error={errors.synopsis}>
        <Textarea value={value.synopsis} onChange={(e) => onChange({ ...value, synopsis: e.target.value })} maxLength={LIMITS.noteMax} />
      </Field>
      <Field label="Target duration (seconds)" error={errors.targetDurationSeconds}>
        <Input value={value.duration} onChange={(e) => onChange({ ...value, duration: e.target.value })} inputMode="numeric" />
      </Field>
      <Field label="Content link" error={errors.contentItemId} helper="The production content item of this episode.">
        <EntitySelect type="content_item" filters={{ projectId }} value={value.contentItemId} onChange={(v) => onChange({ ...value, contentItemId: v })} clearable />
      </Field>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <span className="text-[12px] font-[550] text-fg">Thumbnail</span>
        {value.thumbnailAssetId ? (
          <div className="flex items-center gap-3">
            <AssetThumb workspaceId={workspace.id} assetId={value.thumbnailAssetId} size={128} alt="Episode thumbnail" className="h-9 w-16 object-cover" />
            <Button size="sm" variant="ghost" onClick={() => onChange({ ...value, thumbnailAssetId: null })}>
              Remove Thumbnail
            </Button>
          </div>
        ) : null}
        <FileUploader workspaceId={workspace.id} purpose="content" projectId={projectId} accept="image/jpeg,image/png,image/webp" multiple={false} label="Upload Thumbnail" compact onUploaded={(i) => i.assetId && onChange({ ...value, thumbnailAssetId: i.assetId })} />
      </div>
    </div>
  );
};

const episodeBody = (v: EpisodeFormState) => ({
  number: Number(v.number),
  title: v.title.trim(),
  synopsis: v.synopsis.trim() || null,
  targetDurationSeconds: v.duration ? Number(v.duration) : null,
  language: v.language.trim().toLowerCase(),
  contentItemId: v.contentItemId,
  thumbnailAssetId: v.thumbnailAssetId,
});

const validateEpisode = (v: EpisodeFormState) => {
  const e: Record<string, string> = {};
  if (!/^\d+$/.test(v.number)) e.number = 'Enter a whole number.';
  if (v.title.trim().length < 2) e.title = 'Use 2–120 characters.';
  if (v.language.trim().length < 2) e.language = 'Enter a language code.';
  if (v.duration && !/^\d+$/.test(v.duration)) e.targetDurationSeconds = 'Enter whole seconds.';
  return e;
};

const EpisodeFormDialog = ({ seasonId, projectId, nextNumber, onClose }: { seasonId: string; projectId: string; nextNumber: number; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const [value, setValue] = useState<EpisodeFormState>({ number: String(nextNumber), title: '', synopsis: '', duration: '', language: 'en', contentItemId: null, thumbnailAssetId: null });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const create = useApiMutation(seriesEndpoints.createEpisode, { invalidate: ['series.'], silentErrors: true, successMessage: 'Episode added' });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      dirty={!!value.title}
      title="Add episode"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={create.isPending}
            onClick={async () => {
              const v = validateEpisode(value);
              setErrors(v);
              if (Object.keys(v).length) return;
              setError(null);
              try {
                await create.run({ params: { workspaceId: workspace.id, seasonId }, body: episodeBody(value) });
                onClose();
              } catch (e) {
                if (isApiError(e) && e.fieldErrors.length) setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field, f.message])));
                else setError(errorText(e, 'The episode could not be added.'));
              }
            }}
          >
            Add Episode
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <EpisodeFields value={value} onChange={setValue} projectId={projectId} errors={errors} />
      </div>
    </Dialog>
  );
};

/** Episode details: fields, ordered scenes with keyboard reorder, and other modules' panels. */
const EpisodeDrawer = ({ episodeId, projectId, onClose }: { episodeId: string; projectId: string; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const can = useCan();
  const q = useApiQuery(seriesEndpoints.getEpisode, { params: { workspaceId: workspace.id, episodeId }, query: { includeArchived: true } });
  const [value, setValue] = useState<EpisodeFormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [sceneOpen, setSceneOpen] = useState<SceneView | 'new' | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const update = useApiMutation(seriesEndpoints.updateEpisode, { invalidate: ['series.'], silentErrors: true, successMessage: 'Episode saved' });
  const archive = useApiMutation(seriesEndpoints.archiveEpisode, { invalidate: ['series.'], successMessage: 'Episode archived' });
  const restore = useApiMutation(seriesEndpoints.restoreEpisode, { invalidate: ['series.'], silentErrors: true, successMessage: 'Episode restored' });
  const move = useApiMutation(seriesEndpoints.moveScene, { invalidate: ['series.'] });
  const archiveScene = useApiMutation(seriesEndpoints.archiveScene, { invalidate: ['series.'], successMessage: 'Scene archived' });
  const e = q.data;
  const valuesOf = (x: NonNullable<typeof e>): EpisodeFormState => ({
    number: String(x.number),
    title: x.title,
    synopsis: x.synopsis ?? '',
    duration: x.targetDurationSeconds ? String(x.targetDurationSeconds) : '',
    language: x.language,
    contentItemId: x.contentItem?.id ?? null,
    thumbnailAssetId: x.thumbnailAssetId,
  });
  // Edits work against the episode as loaded (If-Match, changed fields); a background refresh never
  // resets the typing — an untouched form just follows the latest version (T162).
  const [clean, setClean] = useState(true);
  const edit = useEditBase(e, { clean, onReload: (latest) => setValue(valuesOf(latest)) });
  const startBody = edit.start ? episodeBody(valuesOf(edit.start)) : null;
  useEffect(() => {
    if (e) setValue(valuesOf(e));
  }, [e?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!startBody && !!value && JSON.stringify(episodeBody(value)) !== JSON.stringify(startBody);
  useEffect(() => setClean(!dirty), [dirty]);
  const writable = !!e?.permissions.write && !e?.archivedAt;
  const activeScenes = (e?.scenes ?? []).filter((s) => !s.archivedAt);
  const slotProps = { episodeId, projectId };
  const panels = EPISODE_PANELS.items.filter((p) => !p.visible || p.visible(slotProps, can));
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && onClose()}
      width={760}
      dirty={dirty}
      title={e ? `Episode ${e.number}: ${e.title}` : 'Episode'}
      description={e ? `${e.language.toUpperCase()} · ${activeScenes.length} scene(s)` : undefined}
      footer={
        writable && value ? (
          <>
            <Button onClick={onClose}>Close</Button>
            <Button
              variant="primary"
              disabled={!dirty}
              loading={update.isPending}
              onClick={async () => {
                const v = validateEpisode(value);
                setErrors(v);
                if (Object.keys(v).length || !e) return;
                setError(null);
                try {
                  const body = episodeBody(value);
                  const saved = await update.run({ params: { workspaceId: workspace.id, episodeId }, body: startBody ? pickChanged(body, changedFields(startBody, body)) : body }, { ifMatch: edit.version });
                  edit.rebase(saved);
                  setValue(valuesOf(saved));
                } catch (err) {
                  if (edit.catchConflict(err)) return;
                  if (isApiError(err) && err.fieldErrors.length) setErrors(Object.fromEntries(err.fieldErrors.map((f) => [f.field, f.message])));
                  else setError(errorText(err, 'The episode could not be saved.'));
                }
              }}
            >
              Save Episode
            </Button>
          </>
        ) : undefined
      }
    >
      <QueryState query={q}>
        {e && value ? (
          <div className="flex flex-col gap-5">
            {e.archivedAt ? (
              <Banner
                tone="info"
                action={
                  e.permissions.write ? (
                    <Button
                      size="sm"
                      loading={restore.isPending}
                      onClick={async () => {
                        try {
                          await restore.run({ params: { workspaceId: workspace.id, episodeId }, body: {} }, { ifMatch: e.rowVersion });
                        } catch (err) {
                          setError(errorText(err, 'The episode could not be restored.'));
                        }
                      }}
                    >
                      Restore Episode
                    </Button>
                  ) : undefined
                }
              >
                Archived records remain available in historical reports.
              </Banner>
            ) : null}
            {error ? <Banner tone="danger">{error}</Banner> : null}
            {writable ? (
              <EpisodeFields value={value} onChange={setValue} projectId={projectId} errors={errors} />
            ) : (
              <p className="whitespace-pre-wrap text-[14px] text-fg-2">{e.synopsis ?? 'No synopsis.'}</p>
            )}
            {e.contentItem ? (
              <p className="text-[13px]">
                Content: <Link className="text-primary hover:underline" href={`/w/${workspace.id}/content/${e.contentItem.id}`}>{e.contentItem.title}</Link> <StatusBadge status={e.contentItem.stage} label={label('contentStage', e.contentItem.stage)} />
              </p>
            ) : null}
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[16px] font-semibold text-fg">Scenes</h3>
                {writable ? (
                  <Button size="sm" icon={<Plus size={12} />} onClick={() => setSceneOpen('new')}>
                    Add Scene
                  </Button>
                ) : null}
              </div>
              {e.scenes.length === 0 ? <p className="text-[13px] text-fg-2">No scenes yet.</p> : null}
              <ol className="flex flex-col gap-2">
                {e.scenes.map((s) => {
                  const idx = activeScenes.findIndex((x) => x.id === s.id);
                  return (
                    <li key={s.id} className="flex flex-col gap-2 rounded-[12px] border border-line p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {s.thumbnailAssetId ? <AssetThumb workspaceId={workspace.id} assetId={s.thumbnailAssetId} size={64} alt="" className="h-12 w-12 object-cover" /> : null}
                        <span className="min-w-0 flex-1 font-medium text-fg">
                          {s.archivedAt ? '' : `${idx + 1}. `}
                          {s.title}
                        </span>
                        {s.archivedAt ? <StatusBadge status="archived" /> : null}
                        {writable && !s.archivedAt ? (
                          <span className="flex items-center gap-0.5">
                            <IconButton label={`Move ${s.title} up`} icon={<ArrowUp size={16} />} disabled={idx === 0 || move.isPending} onClick={() => void move.run({ params: { workspaceId: workspace.id, sceneId: s.id }, body: { direction: 'up' } }, { ifMatch: s.rowVersion }).catch(() => undefined)} />
                            <IconButton
                              label={`Move ${s.title} down`}
                              icon={<ArrowDown size={16} />}
                              disabled={idx === activeScenes.length - 1 || move.isPending}
                              onClick={() => void move.run({ params: { workspaceId: workspace.id, sceneId: s.id }, body: { direction: 'down' } }, { ifMatch: s.rowVersion }).catch(() => undefined)}
                            />
                            <Button size="sm" variant="ghost" onClick={() => setSceneOpen(s)}>
                              Edit
                            </Button>
                            <IconButton label={`Archive ${s.title}`} icon={<Trash size={16} />} onClick={() => void archiveScene.run({ params: { workspaceId: workspace.id, sceneId: s.id }, body: {} }, { ifMatch: s.rowVersion }).catch(() => undefined)} />
                          </span>
                        ) : null}
                      </div>
                      {s.characters.length ? (
                        <span className="flex flex-wrap gap-1.5">
                          {s.characters.map((c) => (
                            <Badge key={c.characterVersionId}>
                              {c.name} v{c.versionNo}
                            </Badge>
                          ))}
                        </span>
                      ) : null}
                      {s.script ? <p className="line-clamp-3 whitespace-pre-wrap text-[13px] text-fg-2">{s.script}</p> : null}
                      {s.deliverables.length ? (
                        <ul className="flex flex-wrap gap-2 text-[12px] text-fg-2">
                          {s.deliverables.map((d, i) => (
                            <li key={i}>
                              {d.done ? '✓ ' : ''}
                              {d.label}
                              {d.format ? ` (${label('contentFormat', d.format)})` : ''}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </section>
            {panels.map((p) => (
              <Panel key={p.key} title={p.label}>
                <p.component {...slotProps} />
              </Panel>
            ))}
            {writable ? (
              <div className="flex justify-start">
                <Button variant="danger-secondary" onClick={() => setArchiveOpen(true)}>
                  Archive Episode
                </Button>
              </div>
            ) : null}
            <ConfirmDialog
              open={archiveOpen}
              onOpenChange={setArchiveOpen}
              title="Archive episode?"
              body="Episodes with publications are archived, never deleted. The episode number becomes free for a new cut."
              confirmLabel="Archive Episode"
              destructive
              loading={archive.isPending}
              onConfirm={async () => {
                try {
                  await archive.run({ params: { workspaceId: workspace.id, episodeId }, body: {} }, { ifMatch: e.rowVersion });
                  setArchiveOpen(false);
                  toast.success('Episode archived');
                } catch {
                  /* toast shown */
                }
              }}
            />
            {sceneOpen ? <SceneDialog episodeId={episodeId} projectId={projectId} scene={sceneOpen === 'new' ? null : sceneOpen} onClose={() => setSceneOpen(null)} /> : null}
          </div>
        ) : null}
      </QueryState>
      <ConflictDialog {...edit.conflictDialog} />
    </Drawer>
  );
};

const SceneDialog = ({ episodeId, projectId, scene, onClose }: { episodeId: string; projectId: string; scene: SceneView | null; onClose: () => void }) => {
  const { workspace } = useWorkspace();
  const chars = useApiQuery(characterEndpoints.list, { params: { workspaceId: workspace.id, projectId }, query: {} });
  const [title, setTitle] = useState(scene?.title ?? '');
  const [script, setScript] = useState(scene?.script ?? '');
  const [versionIds, setVersionIds] = useState<string[]>(scene?.characters.map((c) => c.characterVersionId) ?? []);
  const [deliverables, setDeliverables] = useState<{ label: string; format?: string; done?: boolean }[]>(scene?.deliverables ?? []);
  const [thumb, setThumb] = useState<string | null>(scene?.thumbnailAssetId ?? null);
  const [error, setError] = useState<string | null>(null);
  // `scene` is the row as it was when the dialog opened; only the fields changed here are sent.
  const edit = useEditBase(scene, {
    onReload: (latest) => {
      setTitle(latest.title);
      setScript(latest.script ?? '');
      setVersionIds(latest.characters.map((c) => c.characterVersionId));
      setDeliverables(latest.deliverables);
      setThumb(latest.thumbnailAssetId);
    },
  });
  const create = useApiMutation(seriesEndpoints.createScene, { invalidate: ['series.'], silentErrors: true, successMessage: 'Scene added' });
  const update = useApiMutation(seriesEndpoints.updateScene, { invalidate: ['series.'], silentErrors: true, successMessage: 'Scene saved' });
  // Scenes link frozen character versions: the approved version, or the open draft if none is approved yet.
  const options = useMemo(() => {
    const list = (chars.data ?? []).flatMap((c) => {
      const v = c.approvedVersion ? { id: c.approvedVersion.id, text: `v${c.approvedVersion.versionNo} approved` } : c.openVersion ? { id: c.openVersion.id, text: `v${c.openVersion.versionNo} ${c.openVersion.state}` } : null;
      return v ? [{ value: v.id, label: `${c.name} (${v.text})` }] : [];
    });
    for (const c of scene?.characters ?? []) if (!list.some((o) => o.value === c.characterVersionId)) list.push({ value: c.characterVersionId, label: `${c.name} (v${c.versionNo})` });
    return list;
  }, [chars.data, scene]);
  const body = {
    title: title.trim(),
    script: script.trim() || null,
    characterVersionIds: versionIds,
    deliverables: deliverables.filter((d) => d.label.trim()).map((d) => ({ label: d.label.trim(), ...(d.format ? { format: d.format as never } : {}), ...(d.done ? { done: true } : {}) })),
    thumbnailAssetId: thumb,
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      dirty={title !== (scene?.title ?? '') || script !== (scene?.script ?? '')}
      title={scene ? `Edit scene: ${scene.title}` : 'Add scene'}
      size="wide"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={title.trim().length < 2}
            loading={create.isPending || update.isPending}
            onClick={async () => {
              setError(null);
              try {
                if (scene) {
                  const s0 = edit.start ?? scene;
                  const before = {
                    title: s0.title,
                    script: s0.script ?? null,
                    characterVersionIds: s0.characters.map((c) => c.characterVersionId),
                    deliverables: s0.deliverables.map((d) => ({ label: d.label, ...(d.format ? { format: d.format as never } : {}), ...(d.done ? { done: true } : {}) })),
                    thumbnailAssetId: s0.thumbnailAssetId,
                  };
                  const patch = pickChanged(body, changedFields(before, body));
                  if (Object.keys(patch).length) await update.run({ params: { workspaceId: workspace.id, sceneId: scene.id }, body: patch }, { ifMatch: edit.version });
                } else await create.run({ params: { workspaceId: workspace.id, episodeId }, body });
                onClose();
              } catch (e) {
                if (!edit.catchConflict(e)) setError(errorText(e, 'The scene could not be saved.'));
              }
            }}
          >
            {scene ? 'Save Scene' : 'Add Scene'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Characters" helper="Scenes refer to a specific character version, never to future profile changes.">
          <MultiSelect value={versionIds} onChange={setVersionIds} options={options} placeholder={chars.isLoading ? 'Loading…' : 'Choose characters'} />
        </Field>
        <Field label="Script">
          <Textarea value={script} onChange={(e) => setScript(e.target.value)} maxLength={LIMITS.richTextMax} className="min-h-[160px]" />
        </Field>
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[12px] font-[550] text-fg">Deliverables</span>
            <Button size="sm" icon={<Plus size={12} />} onClick={() => setDeliverables((d) => [...d, { label: '' }])}>
              Add Deliverable
            </Button>
          </div>
          {deliverables.map((d, i) => (
            <div key={i} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_180px_auto_auto]">
              <Field label={`Deliverable ${i + 1}`}>
                <Input value={d.label} onChange={(e) => setDeliverables((all) => all.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} maxLength={200} />
              </Field>
              <Field label="Format">
                <Select value={d.format ?? null} onChange={(v) => setDeliverables((all) => all.map((x, j) => (j === i ? { ...x, format: v ?? undefined } : x)))} clearable options={CONTENT_FORMATS.map((f) => ({ value: f, label: label('contentFormat', f) }))} />
              </Field>
              <div className="pb-2">
                <Checkbox checked={!!d.done} onCheckedChange={(v) => setDeliverables((all) => all.map((x, j) => (j === i ? { ...x, done: v } : x)))} label="Done" />
              </div>
              <IconButton label={`Remove deliverable ${i + 1}`} icon={<Trash size={16} />} onClick={() => setDeliverables((all) => all.filter((_, j) => j !== i))} />
            </div>
          ))}
        </section>
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-[550] text-fg">Thumbnail</span>
          {thumb ? (
            <div className="flex items-center gap-3">
              <AssetThumb workspaceId={workspace.id} assetId={thumb} size={64} alt="Scene thumbnail" className="h-12 w-12 object-cover" />
              <Button size="sm" variant="ghost" onClick={() => setThumb(null)}>
                Remove Thumbnail
              </Button>
            </div>
          ) : null}
          <FileUploader workspaceId={workspace.id} purpose="content" projectId={projectId} accept="image/jpeg,image/png,image/webp" multiple={false} label="Upload Thumbnail" compact onUploaded={(i) => i.assetId && setThumb(i.assetId)} />
        </div>
      </div>
      <ConflictDialog {...edit.conflictDialog} />
    </Dialog>
  );
};

