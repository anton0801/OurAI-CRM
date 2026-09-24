'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, CaretDoubleLeft, CaretDoubleRight, CaretDown, List, MagnifyingGlass, Plus, SignOut, X } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { shellEndpoints, authEndpoints } from '@castlane/api-contracts';
import { Avatar, Button, IconButton, Menu, cn } from '@castlane/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useApiQuery } from '@/lib/hooks';
import { useLiveEvents } from '@/lib/live-events';
import { useCan, useWorkspace, useWsPath } from '@/lib/workspace-context';
import { CommandPalette } from './command-palette';
import { NAV, NAV_FOOTER, QUICK_CREATE, type NavItem } from './nav';

const readPref = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const writePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable: preference is not persisted */
  }
};

const NavLink = ({ item, collapsed, active, onNavigate }: { item: NavItem; collapsed: boolean; active: boolean; onNavigate?: () => void }) => {
  const wsPath = useWsPath();
  const I = item.icon;
  return (
    <Link
      href={wsPath(item.href)}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      title={collapsed ? item.label : undefined}
      className={cn(
        'flex h-9 items-center gap-3 rounded-[8px] px-3 text-[13px] font-medium text-fg-2 transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg',
        active && 'bg-selection text-fg',
        collapsed && 'justify-center px-0',
      )}
    >
      <I size={18} weight={active ? 'fill' : 'regular'} aria-hidden className={active ? 'text-primary' : undefined} />
      <span className={cn(collapsed && 'sr-only')}>{item.label}</span>
    </Link>
  );
};

const Sidebar = ({ collapsed, onToggle, mobileOpen, onClose }: { collapsed: boolean; onToggle: () => void; mobileOpen: boolean; onClose: () => void }) => {
  const ws = useWorkspace();
  const can = useCan();
  const pathname = usePathname();
  const router = useRouter();
  const [groupState, setGroupState] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      setGroupState(JSON.parse(readPref('castlane.nav.groups') ?? '{}') as Record<string, boolean>);
    } catch {
      setGroupState({});
    }
  }, []);
  const toggleGroup = (k: string) => {
    const next = { ...groupState, [k]: !groupState[k] };
    setGroupState(next);
    writePref('castlane.nav.groups', JSON.stringify(next));
  };
  const visible = (i: NavItem) => i.anyOf.length === 0 || can(i.anyOf);
  const isActive = (href: string) => pathname === `/w/${ws.workspace.id}${href}` || pathname.startsWith(`/w/${ws.workspace.id}${href}/`);
  const body = (isMobile: boolean) => (
    <div className="flex h-full flex-col">
      <div className={cn('flex h-16 shrink-0 items-center gap-2 px-3', collapsed && !isMobile && 'justify-center')}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/castlane-mark.svg" alt="" width={28} height={28} />
        {(!collapsed || isMobile) && (
          <Menu
            label="Switch workspace"
            align="start"
            trigger={
              <button type="button" className="flex min-w-0 flex-1 items-center justify-between gap-1 rounded-[8px] px-2 py-1 text-left hover:bg-surface-2">
                <span className="truncate text-[14px] font-semibold text-fg">{ws.workspace.name}</span>
                <CaretDown size={12} className="shrink-0 text-fg-2" aria-hidden />
              </button>
            }
            items={ws.workspaces.map((w) => ({
              label: w.name,
              onSelect: () => {
                void api.call(authEndpoints.switchWorkspace, { body: { workspaceId: w.id } }).finally(() => router.push(`/w/${w.id}/my-work`));
              },
            }))}
          />
        )}
        {isMobile ? <IconButton label="Close navigation" icon={<X size={18} />} onClick={onClose} tooltip={false} /> : null}
      </div>
      <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {NAV.map((g) => {
          const items = g.items.filter(visible);
          if (items.length === 0) return null;
          const closed = g.label ? groupState[g.key] : false;
          return (
            <div key={g.key} className="mt-3 first:mt-0">
              {g.label && (!collapsed || isMobile) ? (
                <button
                  type="button"
                  aria-expanded={!closed}
                  onClick={() => toggleGroup(g.key)}
                  className="mb-1 flex w-full items-center justify-between rounded px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-fg-2 hover:text-fg"
                >
                  {g.label}
                  <CaretDown size={10} className={cn('transition-transform', closed && '-rotate-90')} aria-hidden />
                </button>
              ) : null}
              {!closed && (
                <ul className="flex flex-col gap-0.5">
                  {items.map((i) => (
                    <li key={i.key}>
                      <NavLink item={i} collapsed={collapsed && !isMobile} active={isActive(i.href)} onNavigate={isMobile ? onClose : undefined} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
      <div className="border-t border-line px-2 py-2">
        <ul className="flex flex-col gap-0.5">
          {NAV_FOOTER.filter(visible).map((i) => (
            <li key={i.key}>
              <NavLink item={i} collapsed={collapsed && !isMobile} active={isActive(i.href)} onNavigate={isMobile ? onClose : undefined} />
            </li>
          ))}
        </ul>
        {!isMobile ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn('mt-1 flex h-9 w-full items-center gap-3 rounded-[8px] px-3 text-[13px] text-fg-2 hover:bg-surface-2 hover:text-fg', collapsed && 'justify-center px-0')}
          >
            {collapsed ? <CaretDoubleRight size={16} aria-hidden /> : <CaretDoubleLeft size={16} aria-hidden />}
            <span className={cn(collapsed && 'sr-only')}>Collapse</span>
          </button>
        ) : null}
      </div>
    </div>
  );
  return (
    <>
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 hidden border-r border-line bg-sidebar transition-[width] duration-[180ms] motion-reduce:transition-none md:block',
          collapsed ? 'w-[72px]' : 'w-[232px]',
        )}
      >
        {body(false)}
      </aside>
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/35" onClick={onClose} />
          <aside className="absolute inset-y-0 left-0 w-[280px] max-w-[85vw] border-r border-line bg-sidebar">{body(true)}</aside>
        </div>
      ) : null}
    </>
  );
};

const Topbar = ({ onOpenNav, onOpenSearch }: { onOpenNav: () => void; onOpenSearch: () => void }) => {
  const ws = useWorkspace();
  const can = useCan();
  const wsPath = useWsPath();
  const router = useRouter();
  const qc = useQueryClient();
  const unread = useApiQuery(shellEndpoints.unreadCount, { params: { workspaceId: ws.workspace.id } }, { refetchInterval: 60_000 });
  const quick = QUICK_CREATE.filter((q) => can(q.anyOf));
  const signOut = async () => {
    try {
      await api.call(authEndpoints.signOut, {});
    } finally {
      qc.clear();
      window.location.assign('/auth/sign-in');
    }
  };
  const count = unread.data?.unread ?? 0;
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-canvas/95 px-4 backdrop-blur md:h-16 md:px-7">
      <IconButton className="md:hidden" label="Open navigation" icon={<List size={20} />} onClick={onOpenNav} tooltip={false} />
      <button
        type="button"
        onClick={onOpenSearch}
        className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[8px] border border-line bg-surface px-3 text-left text-[13px] text-fg-muted hover:border-fg-muted md:max-w-[420px]"
        aria-label="Search (Ctrl+K)"
      >
        <MagnifyingGlass size={16} aria-hidden />
        <span className="truncate">Search</span>
        <kbd className="ml-auto hidden rounded border border-line px-1.5 font-mono text-[11px] text-fg-2 sm:inline">Ctrl K</kbd>
      </button>
      <div className="ml-auto flex items-center gap-1">
        {quick.length > 0 ? (
          <Menu
            label="Quick create"
            trigger={
              <Button variant="primary" size="sm" icon={<Plus size={14} weight="bold" aria-hidden />} className="hidden sm:inline-flex">
                Create
              </Button>
            }
            items={quick.map((q) => ({ label: q.label, onSelect: () => router.push(wsPath(q.href)) }))}
          />
        ) : null}
        <Link
          href={wsPath('/inbox')}
          aria-label={count > 0 ? `Inbox, ${count} unread` : 'Inbox'}
          className="relative inline-flex h-11 w-11 items-center justify-center rounded-[8px] text-fg-2 hover:bg-surface-2 hover:text-fg md:h-9 md:w-9"
        >
          <Bell size={18} aria-hidden />
          {count > 0 ? (
            <span className="absolute right-1 top-1 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-semibold leading-4 text-on-primary">
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </Link>
        <Menu
          label="Profile"
          trigger={
            <button type="button" aria-label="Profile menu" className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-focus)]">
              <Avatar name={ws.user.displayName} src={ws.user.avatarUrl} size={32} />
            </button>
          }
          items={[
            { label: ws.user.displayName, description: ws.user.email, disabled: true },
            { label: 'Personal Settings', onSelect: () => router.push(wsPath('/settings/profile')), separatorBefore: true },
            { label: 'Sessions', onSelect: () => router.push(wsPath('/settings/profile?tab=security')) },
            { label: 'Sign Out', onSelect: () => void signOut(), icon: <SignOut size={14} />, separatorBefore: true },
          ]}
        />
      </div>
    </header>
  );
};

export const AppShell = ({ children }: { children: ReactNode }) => {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const ws = useWorkspace();
  useLiveEvents(ws.workspace.id);
  useEffect(() => {
    setCollapsed(readPref('castlane.sidebar.collapsed') === '1' || (window.innerWidth < 1280 && readPref('castlane.sidebar.collapsed') !== '0'));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    // Apply the member's theme preference (System follows the OS).
    const t = ws.user.theme;
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    writePref('castlane.theme', t);
  }, [ws.user.theme]);
  return (
    <div className="min-h-dvh bg-canvas">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[100] focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <Sidebar
        collapsed={collapsed}
        onToggle={() => {
          writePref('castlane.sidebar.collapsed', collapsed ? '0' : '1');
          setCollapsed(!collapsed);
        }}
        mobileOpen={mobileOpen}
        onClose={() => setMobileOpen(false)}
      />
      <div className={cn('flex min-h-dvh flex-col transition-[padding] duration-[180ms] motion-reduce:transition-none', collapsed ? 'md:pl-[72px]' : 'md:pl-[232px]')}>
        <Topbar onOpenNav={() => setMobileOpen(true)} onOpenSearch={() => setPaletteOpen(true)} />
        <main id="main" className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5 md:px-7 md:py-6" data-density={ws.user.density}>
          {children}
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
};
