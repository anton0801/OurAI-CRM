import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ACCOUNT_STATUSES, canTransition, normalizeProfileUrl } from '@castlane/domain';
import { ACCOUNT_TRANSITIONS } from './accounts';

const handle = fc.stringMatching(/^[a-z0-9._]{3,20}$/);
const tracking = fc.subarray(['utm_source=ig', 'utm_medium=social', 'igshid=abc123', 'igsh=zz', 'fbclid=x1', 'ref=bio'], { minLength: 0 });

describe('profile URL identity', () => {
  it('tracking parameters, www/m hosts, trailing slashes and handle case never change an Instagram identity (T028)', () => {
    fc.assert(
      fc.property(handle, tracking, fc.constantFrom('', 'www.', 'm.'), fc.boolean(), fc.boolean(), (h, params, prefix, slash, upper) => {
        const base = normalizeProfileUrl(`https://instagram.com/${h}`, 'instagram');
        const path = upper ? h.toUpperCase() : h;
        const variant = normalizeProfileUrl(`https://${prefix}instagram.com/${path}${slash ? '/' : ''}${params.length ? `?${params.join('&')}` : ''}`, 'instagram');
        expect(base.ok && variant.ok).toBe(true);
        if (base.ok && variant.ok) expect(variant.value.identityKey).toBe(base.value.identityKey);
      }),
    );
  });

  it('custom sites keep case-sensitive paths distinct (T029)', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z]{3,12}$/).filter((s) => s !== s.toLowerCase()), (seg) => {
        const a = normalizeProfileUrl(`https://fans.example.com/${seg}`, 'other');
        const b = normalizeProfileUrl(`https://fans.example.com/${seg.toLowerCase()}`, 'other');
        expect(a.ok && b.ok).toBe(true);
        if (a.ok && b.ok) expect(a.value.identityKey).not.toBe(b.value.identityKey);
      }),
    );
  });

  it('normalisation is idempotent', () => {
    fc.assert(
      fc.property(handle, tracking, (h, params) => {
        const once = normalizeProfileUrl(`https://www.tiktok.com/@${h}?${params.join('&')}`, 'tiktok');
        if (!once.ok) return;
        const twice = normalizeProfileUrl(once.value.canonicalUrl, 'tiktok');
        expect(twice.ok && twice.value.canonicalUrl).toBe(once.value.canonicalUrl);
      }),
    );
  });

  it('rejects unsafe schemes, plain http and foreign hosts', () => {
    expect(normalizeProfileUrl('javascript:alert(1)', 'other')).toEqual({ ok: false, error: 'INVALID_URL' });
    expect(normalizeProfileUrl('http://instagram.com/emma', 'instagram')).toEqual({ ok: false, error: 'HTTPS_REQUIRED' });
    expect(normalizeProfileUrl('https://evil-instagram.com/emma', 'instagram')).toEqual({ ok: false, error: 'HOST_MISMATCH' });
  });
});

describe('account status machine (section 9)', () => {
  it('matches the specified transitions', () => {
    expect(canTransition(ACCOUNT_TRANSITIONS, 'preparing', 'active')).toBe(true);
    expect(canTransition(ACCOUNT_TRANSITIONS, 'active', 'paused')).toBe(true);
    expect(canTransition(ACCOUNT_TRANSITIONS, 'paused', 'active')).toBe(true);
    expect(canTransition(ACCOUNT_TRANSITIONS, 'active', 'restricted')).toBe(true);
    expect(canTransition(ACCOUNT_TRANSITIONS, 'paused', 'restricted')).toBe(true);
    expect(canTransition(ACCOUNT_TRANSITIONS, 'restricted', 'active')).toBe(true);
    expect(canTransition(ACCOUNT_TRANSITIONS, 'restricted', 'paused')).toBe(false);
    expect(canTransition(ACCOUNT_TRANSITIONS, 'preparing', 'restricted')).toBe(false);
  });

  it('every non-archived state can be archived and archived is terminal for transitions (restore is separate)', () => {
    for (const s of ACCOUNT_STATUSES) {
      if (s === 'archived') expect(ACCOUNT_TRANSITIONS[s]).toEqual([]);
      else expect(ACCOUNT_TRANSITIONS[s]).toContain('archived');
      for (const t of ACCOUNT_TRANSITIONS[s]) expect(ACCOUNT_STATUSES).toContain(t);
      expect(ACCOUNT_TRANSITIONS[s]).not.toContain(s);
    }
  });
});
