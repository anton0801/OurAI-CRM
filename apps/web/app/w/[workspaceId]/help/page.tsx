import { PageHeader, Panel } from '@castlane/ui';

export const metadata = { title: 'Help' };

const SHORTCUTS: [string, string][] = [
  ['Ctrl K / ⌘ K', 'Search records and jump to them'],
  ['Esc', 'Close the open dialog, drawer or menu (unsaved changes ask first)'],
  ['↑ ↓ then Enter', 'Move through picker and search results and choose one'],
  ['Tab / Shift Tab', 'Move between controls; every action is reachable without a mouse'],
  ['Move to…', 'On boards and calendars, the item menu moves a card without dragging'],
];

const RULES: [string, string][] = [
  ['Account links', 'Account links do not import statistics or publish content. Statistics are entered or imported by your team.'],
  ['Publications', 'A publication becomes Published only when someone marks it with the real URL and time — never because the scheduled time passed.'],
  ['Approvals', 'An approval belongs to one version. Uploading a new version needs a new review.'],
  ['Missing data', 'Missing values are shown as “No data recorded for this period.”, never as zero. Charts leave gaps.'],
  ['Payments', 'Record Payment records a payment already made. It does not transfer money.'],
  ['Posted finance', 'Posted entries cannot be edited. Corrections are made with a reversal or replacement entry.'],
  ['Archive and Trash', 'Archive keeps history and reports. Trash holds eligible drafts for 30 days before they are purged.'],
  ['Access', 'You only see records your roles allow. If something is missing, ask an administrator — Explain Access shows why.'],
];

export default function HelpPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Help" description="How the workspace behaves, keyboard shortcuts and where to get support." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Keyboard">
          <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-4 gap-y-3 px-4 py-4 text-[14px] leading-[22px]">
            {SHORTCUTS.map(([k, v]) => (
              <div key={k} className="contents">
                <dt>
                  <kbd className="rounded-[6px] border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-fg">{k}</kbd>
                </dt>
                <dd className="text-fg-2">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel title="Getting support">
          <div className="flex flex-col gap-3 px-4 py-4 text-[14px] leading-[22px] text-fg-2">
            <p>Questions about access, roles or workspace settings go to your workspace administrators. Settings → Team lists members and their roles.</p>
            <p>If something looks broken, note the time and what you clicked. Error messages include a request ID — share it with the administrator so the issue can be traced without sharing your screen or data.</p>
            <p>Written instructions for everyday work live in the Knowledge Base.</p>
          </div>
        </Panel>
      </div>
      <Panel title="How Castlane works">
        <dl className="divide-y divide-line">
          {RULES.map(([k, v]) => (
            <div key={k} className="grid gap-1 px-4 py-3 md:grid-cols-[200px_1fr] md:gap-4">
              <dt className="text-[13px] font-[600] text-fg">{k}</dt>
              <dd className="text-[14px] leading-[22px] text-fg-2">{v}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}
