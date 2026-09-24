'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { emptyRichTextDoc, knowledgeEndpoints, type ArticleDetail, type RichTextDocument } from '@castlane/api-contracts';
import { isApiError } from '@castlane/api-client';
import { ARTICLE_SCOPE_TYPES } from '@castlane/api-contracts';
import { Banner, Button, Field, Input, Panel, Select, Switch } from '@castlane/ui';
import { EntitySelect } from '@/components/common/entity-select';
import { ConflictDialog } from '@/components/common/conflict';
import { DirectionSelect, MemberSelect } from '@/components/common/pickers';
import { keyFor, useApiMutation } from '@/lib/hooks';
import { label } from '@/lib/labels';
import { useUnsavedChangesGuard } from '@/lib/unsaved';
import { useWorkspace } from '@/lib/workspace-context';
import { RichTextEditor, toDoc, toEditorBlocks, type EditorBlock } from './rich-text-editor';
import { RichTextView } from './rich-text-view';

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';

const AUTOSAVE_MS = 1000;

/**
 * Draft editor (S39): autosave of the draft text with a 1000 ms debounce and visible
 * Saving / Saved / Save Failed; explicit Save Draft; details saved explicitly. Every save sends
 * If-Match — a conflicting change by someone else opens the conflict dialog and keeps the text.
 */
export const ArticleEditor = ({ article, canUpload }: { article: ArticleDetail; canUpload: boolean }) => {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const getKey = keyFor(knowledgeEndpoints.get, { params: { workspaceId: workspace.id, articleId: article.id } });
  const base = article.draft ?? article.published;
  const [title, setTitle] = useState(base?.title ?? article.title);
  const [blocks, setBlocks] = useState<EditorBlock[]>(() => toEditorBlocks((base?.body as RichTextDocument | undefined) ?? emptyRichTextDoc()));
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [preview, setPreview] = useState(false);
  const rowVersion = useRef(article.rowVersion);
  const external = article.rowVersion > rowVersion.current && state !== 'saving';
  const save = useApiMutation(knowledgeEndpoints.update, { silentErrors: true });
  const saving = useRef(false);

  // Details (explicit save).
  const [categoryId, setCategoryId] = useState<string | null>(article.category.id);
  const [scopeType, setScopeType] = useState(article.scope.type);
  const [scopeId, setScopeId] = useState<string | null>(article.scope.id);
  const [ownerId, setOwnerId] = useState<string | null>(article.owner.membershipId);
  const [required, setRequired] = useState(article.requiredReading);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const detailsDirty =
    categoryId !== article.category.id || scopeType !== article.scope.type || (scopeType !== 'workspace' && scopeId !== article.scope.id) || ownerId !== article.owner.membershipId || required !== article.requiredReading;
  const saveDetails = useApiMutation(knowledgeEndpoints.update, { silentErrors: true, successMessage: 'Details saved' });

  useUnsavedChangesGuard(state === 'dirty' || state === 'saving' || state === 'failed' || detailsDirty);

  const doSave = useCallback(
    async (autosave: boolean) => {
      if (saving.current) return;
      saving.current = true;
      setState('saving');
      setError(null);
      try {
        const r = await save.run(
          { params: { workspaceId: workspace.id, articleId: article.id }, body: { title: title.trim(), body: toDoc(blocks), autosave } },
          { ifMatch: rowVersion.current },
        );
        rowVersion.current = r.rowVersion;
        qc.setQueryData(getKey, r);
        void qc.invalidateQueries({ queryKey: [knowledgeEndpoints.list.id] });
        void qc.invalidateQueries({ queryKey: [knowledgeEndpoints.versions.id] });
        setState((s) => (s === 'saving' ? 'saved' : s));
      } catch (e) {
        setState('failed');
        if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
        else setError(isApiError(e) ? (e.network ? 'You are offline. Changes are not being saved.' : (e.fieldErrors[0]?.message ?? e.message)) : 'The draft could not be saved.');
      } finally {
        saving.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [title, blocks, article.id, workspace.id],
  );

  // Autosave after 1000 ms without changes.
  useEffect(() => {
    if (state !== 'dirty') return;
    const t = setTimeout(() => void doSave(true), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [state, title, blocks, doSave]);

  const change = (fn: () => void) => {
    fn();
    setState('dirty');
  };

  const statusText = state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : state === 'failed' ? 'Save Failed' : state === 'dirty' ? 'Unsaved changes' : article.draft ? 'Draft' : 'Editing starts a new draft';

  return (
    <div className="flex flex-col gap-4">
      {external ? <Banner tone="warning">Updated by another member. Your unsaved text stays here; saving will ask you to compare changes first.</Banner> : null}
      {!article.draft && article.published ? <Banner tone="info">The published version stays unchanged. Your edits create a new draft version that you can publish later.</Banner> : null}
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <span className={state === 'failed' ? 'text-[13px] font-medium text-danger' : 'text-[13px] text-fg-2'} role="status">
          {statusText}
        </span>
        {error ? <span className="text-[13px] text-danger">{error}</span> : null}
        <span className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
            {preview ? 'Back to Editing' : 'Preview'}
          </Button>
          <Button size="sm" onClick={() => void doSave(false)} loading={state === 'saving'} disabled={state === 'idle' || state === 'saved'}>
            {state === 'failed' ? 'Retry Save' : 'Save Draft'}
          </Button>
        </span>
      </div>
      <Field label="Title" required>
        <Input value={title} onChange={(e) => change(() => setTitle(e.target.value))} maxLength={120} className="text-[16px] font-semibold" />
      </Field>
      {preview ? (
        <div className="rounded-[12px] border border-line bg-surface p-4">
          <RichTextView doc={toDoc(blocks)} />
        </div>
      ) : (
        <RichTextEditor blocks={blocks} onChange={(b) => change(() => setBlocks(b))} articleId={article.id} canUpload={canUpload} />
      )}

      <Panel title="Details" description="Category, scope, owner and required reading are saved separately from the text.">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {detailsError ? <Banner tone="danger" className="md:col-span-2">{detailsError}</Banner> : null}
          <Field label="Category" required>
            <EntitySelect type="article_category" value={categoryId} onChange={(v) => setCategoryId(v)} />
          </Field>
          <Field label="Owner" required>
            <MemberSelect value={ownerId} onChange={setOwnerId} />
          </Field>
          <Field label="Scope" required helper="Who can read the published text.">
            <Select value={scopeType} onChange={(v) => setScopeType((v as typeof scopeType) ?? 'workspace')} options={ARTICLE_SCOPE_TYPES.map((s) => ({ value: s, label: label('articleScope', s) }))} />
          </Field>
          {scopeType === 'project' ? (
            <Field label="Project" required>
              <EntitySelect type="project" value={scopeId} onChange={(v) => setScopeId(v)} />
            </Field>
          ) : scopeType === 'direction' ? (
            <Field label="Direction" required>
              <DirectionSelect value={scopeId} onChange={setScopeId} />
            </Field>
          ) : (
            <span />
          )}
          <div className="md:col-span-2">
            <Switch
              label="Required reading"
              description="Members asked to read it must confirm with Acknowledge Read. A major revision asks them again."
              checked={required}
              onCheckedChange={setRequired}
            />
          </div>
          <div className="flex justify-end md:col-span-2">
            <Button
              variant="primary"
              disabled={!detailsDirty || !categoryId || !ownerId || (scopeType !== 'workspace' && !scopeId)}
              loading={saveDetails.isPending}
              onClick={async () => {
                setDetailsError(null);
                try {
                  const r = await saveDetails.run(
                    {
                      params: { workspaceId: workspace.id, articleId: article.id },
                      body: { categoryId: categoryId!, scopeType, scopeId: scopeType === 'workspace' ? null : scopeId, ownerMembershipId: ownerId!, requiredReading: required },
                    },
                    { ifMatch: rowVersion.current },
                  );
                  rowVersion.current = r.rowVersion;
                  qc.setQueryData(getKey, r);
                  void qc.invalidateQueries({ queryKey: [knowledgeEndpoints.list.id] });
                } catch (e) {
                  if (isApiError(e) && e.code === 'VERSION_CONFLICT') setConflict(true);
                  else setDetailsError(isApiError(e) ? (e.fieldErrors[0]?.message ?? e.message) : 'The details could not be saved.');
                }
              }}
            >
              Save Details
            </Button>
          </div>
        </div>
      </Panel>
      <ConflictDialog open={conflict} onOpenChange={setConflict} onReload={() => window.location.reload()} />
    </div>
  );
};
