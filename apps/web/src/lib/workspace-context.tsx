'use client';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { setCsrfToken } from './api';

export interface WorkspaceSession {
  workspace: { id: string; name: string; timezone: string; baseCurrency: string; weekStartsOn: 'monday' | 'sunday'; logoUrl: string | null };
  user: { id: string; displayName: string; email: string; avatarUrl: string | null; timezone: string; theme: 'system' | 'light' | 'dark'; density: 'comfortable' | 'compact' };
  membershipId: string;
  isOwner: boolean;
  /** Permission keys held in at least one scope (navigation and button visibility only — the server decides). */
  permissions: string[];
  workspaces: { id: string; name: string }[];
  csrfToken: string;
}

const Ctx = createContext<WorkspaceSession | null>(null);

export const WorkspaceProvider = ({ value, children }: { value: WorkspaceSession; children: ReactNode }) => {
  // Token is kept in memory for this tab only.
  setCsrfToken(value.csrfToken);
  useEffect(() => {
    setCsrfToken(value.csrfToken);
  }, [value.csrfToken]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useWorkspace = (): WorkspaceSession => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkspace must be used inside a workspace route');
  return v;
};

/** Visibility helper. Hidden buttons are a courtesy — every action is authorised on the server. */
export const useCan = () => {
  const { permissions, isOwner } = useWorkspace();
  const set = useMemo(() => new Set(permissions), [permissions]);
  return (p: string | string[]) => isOwner || (Array.isArray(p) ? p.some((x) => set.has(x)) : set.has(p));
};

/** Build a workspace-scoped path: wsPath('/projects') → /w/<id>/projects */
export const useWsPath = () => {
  const { workspace } = useWorkspace();
  return (p: string) => `/w/${workspace.id}${p.startsWith('/') ? p : `/${p}`}`;
};
