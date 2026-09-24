'use client';
import { ArrowDown, Funnel, Lightning, ListChecks, ShieldCheck } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type { AutomationCatalog } from '@castlane/api-contracts';
import { label } from '@/lib/labels';
import { actionSentence, conditionSentence, triggerOf, triggerSentence, type RuleDraft } from './model';

const Step = ({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) => (
  <li className="rounded-[10px] border border-line bg-surface p-3">
    <p className="flex items-center gap-2 text-[12px] font-[550] uppercase tracking-[0.02em] text-fg-2">
      <span aria-hidden className="text-primary">
        {icon}
      </span>
      {title}
    </p>
    <div className="mt-1.5 text-[13px] leading-5 text-fg">{children}</div>
  </li>
);

const Arrow = () => (
  <li aria-hidden className="flex justify-center py-1 text-fg-muted">
    <ArrowDown size={16} />
  </li>
);

/**
 * The rule as a flow (S65: the conditions/actions scheme is drawn in code, no images):
 * trigger → conditions (all must match) → actions, executed as owner ∩ scope.
 */
export const RuleFlowDiagram = ({ draft, catalog, ownerName, scopeLabel }: { draft: RuleDraft; catalog: AutomationCatalog | undefined; ownerName: string | null; scopeLabel: string }) => {
  const t = triggerOf(catalog, draft.config.trigger.event);
  const { conditions, actions } = draft.config;
  return (
    <ol className="flex flex-col" aria-label="Rule flow">
      <Step icon={<Lightning size={14} weight="fill" />} title={`When · ${label('automationTriggerKind', t?.kind ?? 'event')}`}>
        {triggerSentence(catalog, draft.config.trigger)}
      </Step>
      <Arrow />
      <Step icon={<Funnel size={14} weight="fill" />} title="If all match">
        {t?.kind === 'schedule' ? (
          <span className="text-fg-2">Scheduled rules have no triggering record; they always run at the slot.</span>
        ) : conditions.length === 0 ? (
          <span className="text-fg-2">No conditions — runs for every matching event in the scope.</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {conditions.map((c, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="text-fg-muted">{i === 0 ? '•' : 'and'}</span>
                <span>{conditionSentence(t, c)}</span>
              </li>
            ))}
          </ul>
        )}
      </Step>
      <Arrow />
      <Step icon={<ListChecks size={14} weight="fill" />} title="Then">
        {actions.length === 0 ? (
          <span className="text-warning">Add at least one action.</span>
        ) : (
          <ol className="flex flex-col gap-1">
            {actions.map((a, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="tabular-nums text-fg-muted">{i + 1}.</span>
                <span className="min-w-0 break-words">{actionSentence(catalog, a)}</span>
              </li>
            ))}
          </ol>
        )}
      </Step>
      <Arrow />
      <Step icon={<ShieldCheck size={14} weight="fill" />} title="Runs as">
        {ownerName ? (
          <>
            {ownerName}’s current rights, limited to {scopeLabel}. If that access is lost, the rule pauses instead of acting.
          </>
        ) : (
          <span className="text-warning">Needs Owner — the rule cannot run until an owner is assigned.</span>
        )}
      </Step>
    </ol>
  );
};
