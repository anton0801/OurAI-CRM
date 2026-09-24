'use client';
import { useEffect } from 'react';

/** Warn before leaving the page with unsaved changes (browser navigation / tab close). */
export const useUnsavedChangesGuard = (dirty: boolean) => {
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
};
