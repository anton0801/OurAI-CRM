'use client';
import Link from 'next/link';
import { Archive, Buildings, ClockCounterClockwise, Compass, DownloadSimple, Gauge, ListChecks, ShieldCheck, UploadSimple, UserCircle, UsersThree, type Icon } from '@phosphor-icons/react';
import { PageHeader } from '@castlane/ui';
import { useCan, useWsPath } from '@/lib/workspace-context';

interface Entry {
  href: string;
  title: string;
  description: string;
  icon: Icon;
  /** Visible when the member holds any of these (empty = everyone). */
  anyOf: string[];
}

const ENTRIES: Entry[] = [
  { href: '/settings/profile', title: 'Personal Settings', description: 'Profile, avatar, theme, notifications, password, two-factor and sessions.', icon: UserCircle, anyOf: [] },
  { href: '/settings/workspace', title: 'Workspace Settings', description: 'Name, logo, time zone, currency, working time, retention, security policy and mail.', icon: Buildings, anyOf: ['workspace.read'] },
  { href: '/settings/access', title: 'Roles and Access', description: 'Role presets, custom roles, grants, Explain Access and ownership transfer.', icon: ShieldCheck, anyOf: ['access.read'] },
  { href: '/team', title: 'Team', description: 'Members, invitations, duties and deactivation.', icon: UsersThree, anyOf: ['members.read'] },
  { href: '/directions', title: 'Directions', description: 'Business directions, their leads and order.', icon: Compass, anyOf: ['directions.read'] },
  { href: '/settings/audit', title: 'Audit Log', description: 'History of important changes with masked field differences.', icon: ClockCounterClockwise, anyOf: ['audit.read'] },
  { href: '/settings/templates', title: 'Templates and Custom Fields', description: 'Reusable task, content and checklist templates; custom fields.', icon: ListChecks, anyOf: ['templates.manage', 'custom-fields.manage'] },
  { href: '/imports', title: 'Import Center', description: 'Upload CSV or XLSX files, map columns, validate and confirm imports.', icon: UploadSimple, anyOf: ['imports.create'] },
  { href: '/exports', title: 'Export Center', description: 'Request CSV or XLSX exports of records you may see; downloads expire after 7 days.', icon: DownloadSimple, anyOf: ['exports.create'] },
  { href: '/archive', title: 'Archive and Trash', description: 'Archived and recently deleted records.', icon: Archive, anyOf: [] },
  { href: '/operations/health', title: 'System Health', description: 'Incidents, jobs, mail delivery and backup status.', icon: Gauge, anyOf: ['incidents.read', 'system.jobs.read', 'backups.status.read'] },
];

/** Settings landing page: only the sections the member can open are listed. */
export const SettingsHub = () => {
  const can = useCan();
  const wsPath = useWsPath();
  const visible = ENTRIES.filter((e) => e.anyOf.length === 0 || can(e.anyOf));
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Settings" description="Your own preferences and, depending on your role, workspace configuration." />
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((e) => {
          const I = e.icon;
          return (
            <li key={e.href}>
              <Link
                href={wsPath(e.href)}
                className="flex h-full items-start gap-3 rounded-[12px] border border-line bg-surface p-4 transition-colors duration-[120ms] hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)]"
              >
                <I size={22} className="mt-0.5 shrink-0 text-primary" aria-hidden />
                <span className="flex flex-col gap-1">
                  <span className="text-[15px] font-semibold text-fg">{e.title}</span>
                  <span className="text-[13px] leading-5 text-fg-2">{e.description}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
