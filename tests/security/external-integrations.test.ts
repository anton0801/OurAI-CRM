import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountEndpoints, overviewEndpoints, projectEndpoints, shellEndpoints } from '@castlane/api-contracts';
import { getAppServices } from '@castlane/application';
import { clientFor, createDirection, createWorkspace, sessionFor } from '../support';

/**
 * T172 and the product boundary (spec §1, R03/R04): the CRM never calls Dramora or any social
 * platform, never scrapes or autoposts; account links are stored as links only. Everything works
 * with no such integration configured.
 */
const root = new URL('../..', import.meta.url).pathname;
const db = () => getAppServices().db;

const sourceFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.next') || name === 'dist') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(relative(root, p));
    }
  };
  for (const top of ['apps', 'packages']) for (const pkg of readdirSync(join(root, top))) for (const sub of ['src', 'app']) {
    const d = join(root, top, pkg, sub);
    try {
      if (statSync(d).isDirectory()) walk(d);
    } catch {
      /* package without this folder */
    }
  }
  return out;
};

/** Browser-side calls that only reach this application (same-origin API, events, pre-signed storage). */
const ALLOWED_NETWORK_CALLS = new Set([
  'apps/web/src/lib/api.ts',
  'apps/web/src/lib/live-events.ts',
  // Uploads PUT file parts to short-lived URLs issued by this application's own storage.
  'apps/web/src/features/settings/profile-settings.tsx',
  'apps/web/src/components/media/use-upload.ts',
  'apps/web/src/features/imports/upload.ts',
]);
const NETWORK = /\bfetch\(|new WebSocket\(|new EventSource\(|XMLHttpRequest|from 'node:https?'|from 'https?'|require\('https?'\)|from '(undici|axios|got|node-fetch|ky)'/;
const PLATFORM_HOST = /https?:\/\/[^'"`\s)]*(dramora|instagram|tiktok|onlyfans|facebook|twitter|fansly|youtube|threads\.net|x\.com)/i;

describe('no external platform integrations (T172)', () => {
  it('application code makes no outbound HTTP calls except same-origin browser requests', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(300);
    const offenders = files.filter((f) => !ALLOWED_NETWORK_CALLS.has(f) && NETWORK.test(readFileSync(join(root, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no Dramora or social-platform endpoint is referenced by application code (fixtures aside)', () => {
    const offenders = sourceFiles()
      .filter((f) => !f.startsWith('packages/test-fixtures/'))
      .filter((f) => PLATFORM_HOST.test(readFileSync(join(root, f), 'utf8')));
    expect(offenders).toEqual([]);
    // Configuration has no integration settings to fill in: nothing to "configure" for Dramora.
    const keys = Object.keys(getAppServices().config);
    expect(keys.filter((k) => /DRAMORA|INSTAGRAM|TIKTOK|ONLYFANS|META_|FACEBOOK/i.test(k))).toEqual([]);
  });

  describe('runtime', () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    beforeEach(() => {
      calls.length = 0;
      globalThis.fetch = (async (input: string | URL | Request) => {
        calls.push(String(input instanceof Request ? input.url : input));
        throw new Error('outbound network is not allowed in this test');
      }) as typeof fetch;
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it('core flows work with no integration configured and never reach the network; platform links stay links', async () => {
      const ws = await createWorkspace(db());
      const owner = await clientFor(await sessionFor(db(), ws.owner.userId));
      const W = { workspaceId: ws.workspaceId };
      const directionId = await createDirection(db(), ws, 'AI Influencers');
      const project = await owner.call(projectEndpoints.create, { params: W, body: { name: 'Mila', type: 'influencer', directionId, ownerMembershipId: ws.owner.membershipId } });
      const account = await owner.call(accountEndpoints.create, {
        params: W,
        body: { projectId: project.id, platform: 'instagram', handle: 'mila.daily', profileUrl: 'https://www.instagram.com/mila.daily', ownerMembershipId: ws.owner.membershipId },
      });
      expect(account.originalUrl).toBe('https://www.instagram.com/mila.daily');
      // The URL check is local normalisation and duplicate detection, not a request to the platform.
      const preview = await owner.call(accountEndpoints.urlPreview, { params: W, query: { platform: 'instagram', url: 'https://www.instagram.com/mila.daily/?utm_source=share' } });
      expect(preview).toMatchObject({ canonicalUrl: expect.stringContaining('instagram.com/mila.daily'), removedParams: ['utm_source'] });
      expect(preview.duplicate?.account?.id).toBe(account.id);
      const found = await owner.call(shellEndpoints.search, { params: W, query: { q: 'mila' } });
      expect(JSON.stringify(found)).toContain('mila.daily');
      await owner.call(overviewEndpoints.get, { params: W, query: {} });
      // Nothing was fetched: no profile preview, no scraping, no Dramora call.
      expect(calls).toEqual([]);
    });
  });
});
