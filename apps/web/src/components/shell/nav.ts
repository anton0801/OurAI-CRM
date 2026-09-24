import {
  Books,
  Briefcase,
  CalendarBlank,
  ChartLineUp,
  ChatsCircle,
  CheckSquare,
  CurrencyCircleDollar,
  FilmSlate,
  FolderOpen,
  Gear,
  House,
  ImagesSquare,
  Lightbulb,
  Megaphone,
  Question,
  SquaresFour,
  Tray,
  UserCircle,
  UsersThree,
  Target,
  Gauge,
  type Icon,
} from '@phosphor-icons/react';

export interface NavItem {
  key: string;
  label: string;
  href: string;
  icon: Icon;
  /** Visible when the member holds any of these permissions (empty = everyone). */
  anyOf: string[];
}

export interface NavGroup {
  key: string;
  label: string | null;
  items: NavItem[];
}

/** Sidebar (section 4.4). Sections a member cannot use are hidden; the server filters data anyway. */
export const NAV: NavGroup[] = [
  {
    key: 'main',
    label: null,
    items: [
      { key: 'overview', label: 'Overview', href: '/overview', icon: House, anyOf: ['analytics.production.read', 'projects.read'] },
      { key: 'my-work', label: 'My Work', href: '/my-work', icon: CheckSquare, anyOf: [] },
      { key: 'inbox', label: 'Inbox', href: '/inbox', icon: Tray, anyOf: [] },
    ],
  },
  {
    key: 'production',
    label: 'Production',
    items: [
      { key: 'projects', label: 'Projects', href: '/projects', icon: Briefcase, anyOf: ['projects.read'] },
      { key: 'accounts', label: 'Accounts', href: '/accounts', icon: UserCircle, anyOf: ['accounts.read'] },
      { key: 'content', label: 'Content', href: '/content', icon: FilmSlate, anyOf: ['content.read'] },
      { key: 'tasks', label: 'Tasks', href: '/tasks', icon: SquaresFour, anyOf: ['tasks.read'] },
      { key: 'calendar', label: 'Calendar', href: '/calendar', icon: CalendarBlank, anyOf: ['publications.read', 'tasks.read', 'shifts.read.own', 'shifts.read.scope'] },
      { key: 'references', label: 'References', href: '/references', icon: Lightbulb, anyOf: ['references.read'] },
      { key: 'library', label: 'Library', href: '/library', icon: ImagesSquare, anyOf: ['assets.read'] },
    ],
  },
  {
    key: 'operations',
    label: 'Operations',
    items: [
      { key: 'ofm', label: 'OFM', href: '/ofm', icon: ChatsCircle, anyOf: ['ofm.overview.read'] },
      { key: 'campaigns', label: 'Campaigns', href: '/campaigns', icon: Megaphone, anyOf: ['campaigns.read'] },
      { key: 'partners', label: 'Partners', href: '/partners', icon: FolderOpen, anyOf: ['partners.read', 'deals.read'] },
      { key: 'team', label: 'Team', href: '/team', icon: UsersThree, anyOf: ['members.read'] },
    ],
  },
  {
    key: 'insights',
    label: 'Insights',
    items: [
      {
        key: 'analytics',
        label: 'Analytics',
        href: '/analytics',
        icon: ChartLineUp,
        anyOf: ['analytics.production.read', 'analytics.accounts.read', 'analytics.content.read', 'analytics.ofm.read', 'analytics.team.read', 'analytics.finance.read'],
      },
      { key: 'metrics', label: 'Metrics', href: '/metrics', icon: Gauge, anyOf: ['metrics.read'] },
      { key: 'goals', label: 'Goals', href: '/goals', icon: Target, anyOf: ['goals.read'] },
      { key: 'finance', label: 'Finance', href: '/finance', icon: CurrencyCircleDollar, anyOf: ['finance.read', 'budgets.read', 'compensation.runs.read', 'compensation.own.read'] },
      { key: 'knowledge', label: 'Knowledge', href: '/knowledge', icon: Books, anyOf: ['knowledge.read'] },
    ],
  },
];

export const NAV_FOOTER: NavItem[] = [
  { key: 'settings', label: 'Settings', href: '/settings', icon: Gear, anyOf: [] },
  { key: 'help', label: 'Help', href: '/help', icon: Question, anyOf: [] },
];

export interface QuickCreateItem {
  label: string;
  href: string;
  anyOf: string[];
}

/** Quick Create opens forms only; nothing is created until the form is submitted. */
export const QUICK_CREATE: QuickCreateItem[] = [
  { label: 'New Project', href: '/projects/new', anyOf: ['projects.create'] },
  { label: 'New Task', href: '/tasks?create=1', anyOf: ['tasks.create'] },
  { label: 'New Content', href: '/content/new', anyOf: ['content.create'] },
  { label: 'Add Account', href: '/accounts/new', anyOf: ['accounts.write'] },
  { label: 'New Publication', href: '/publications/new', anyOf: ['publications.write'] },
  { label: 'Add Metrics', href: '/metrics/new', anyOf: ['metrics.write'] },
  { label: 'Add Reference', href: '/references?create=1', anyOf: ['references.write'] },
  { label: 'New Financial Entry', href: '/finance/entries/new', anyOf: ['finance.create'] },
  { label: 'Upload Files', href: '/library?upload=1', anyOf: ['assets.upload'] },
  { label: 'New Article', href: '/knowledge/new', anyOf: ['knowledge.write'] },
];
