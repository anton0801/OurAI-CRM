'use client';
/** MFA challenge handle kept in tab-scoped storage only for the few minutes of the sign-in step. */
const KEY = 'castlane.challenge';
export const saveChallenge = (c: { id: string; kind: 'verify' | 'setup' }) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
};
export const readChallenge = (): { id: string; kind: 'verify' | 'setup' } | null => {
  try {
    const v = sessionStorage.getItem(KEY);
    return v ? (JSON.parse(v) as { id: string; kind: 'verify' | 'setup' }) : null;
  } catch {
    return null;
  }
};
export const clearChallenge = () => {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
};
