'use client';
import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { automationEndpoints } from '@castlane/api-contracts';
import { Banner, PageHeader, PermissionDenied, Skeleton } from '@castlane/ui';
import { useApiQuery } from '@/lib/hooks';
import { useUrlState } from '@/lib/url-state';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { blankDraft, useAutomationCatalog, type RuleDraft } from './model';
import { RuleEditor } from './rule-editor';

/** New rule (S65), blank or from a starter template (?template=key). Saved disabled as version 1. */
export const NewRuleScreen = () => {
  const { workspace, membershipId } = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const { state } = useUrlState<'template'>();
  const catalog = useAutomationCatalog();
  const templates = useApiQuery(automationEndpoints.templates, { params: { workspaceId: workspace.id } }, { enabled: !!state.template, staleTime: 5 * 60_000 });
  const template = templates.data?.find((t) => t.key === state.template);
  const initial = useMemo<RuleDraft | null>(() => {
    if (!catalog.data) return null;
    if (state.template && templates.isLoading) return null;
    const base = blankDraft(catalog.data, membershipId);
    return template ? { ...base, name: template.name, config: template.config } : base;
  }, [catalog.data, membershipId, state.template, template, templates.isLoading]);

  if (!can('automations.create')) return <PermissionDenied />;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        crumbs={[{ label: 'Automations', href: wsPath('/automations') }, { label: 'New Rule' }]}
        title={template ? `New Rule from “${template.name}”` : 'New Rule'}
        description="Choose a trigger, optional conditions and internal actions. The rule is saved disabled; enable it after Validate and a Dry Run."
      />
      {state.template && templates.data && !template ? <Banner tone="warning">That template is no longer available; starting from a blank rule.</Banner> : null}
      {initial ? (
        <RuleEditor key={template?.key ?? 'blank'} initial={initial} onSaved={(r) => router.replace(wsPath(`/automations/${r.id}`))} />
      ) : (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      )}
    </div>
  );
};
