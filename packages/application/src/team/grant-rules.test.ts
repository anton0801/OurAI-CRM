import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, ROLE_PRESETS, isFinancePermission, isSensitivePermission, type AccessSnapshot } from '@castlane/authorization';
import {
  canEditRole,
  canManagePattern,
  canManagePermission,
  canManageRole,
  createsManagerCycle,
  diffPermissions,
  expandPermissionPattern,
  isProtectedRole,
  isSensitiveRole,
  normalizePermissions,
  roleNeedsOwner,
} from './grant-rules';
import { memberVisibility } from './scope';

const snapshot = (over: Partial<AccessSnapshot> & { perms?: string[]; scopeType?: AccessSnapshot['grants'][number]['scopeType']; scopeId?: string | null } = {}): AccessSnapshot => ({
  workspaceId: 'ws',
  userId: 'u1',
  membershipId: 'm1',
  membershipStatus: 'active',
  accessRevision: 1,
  isOwner: false,
  grants: over.perms ? [{ roleId: 'r', roleKey: 'custom', permissions: new Set(over.perms), scopeType: over.scopeType ?? 'workspace', scopeId: over.scopeId ?? null }] : [],
  denies: [],
  assignedProjectIds: new Set(),
  assignedAccountIds: new Set(),
  projectDirection: new Map(),
  accountProject: new Map(),
  ...over,
});

const preset = (key: string) => {
  const p = ROLE_PRESETS.find((r) => r.key === key)!;
  return { key: p.key, permissions: p.permissions as readonly string[], isProtected: p.isProtected };
};

const owner = snapshot({ isOwner: true });
const admin = snapshot({ perms: [...preset('admin').permissions] });
const lead = snapshot({ perms: [...preset('direction_lead').permissions], scopeType: 'direction', scopeId: 'd1' });

describe('grant rules (§7.1)', () => {
  it('the Owner role is protected and never editable, grantable or revocable by anyone', () => {
    const o = preset('owner');
    expect(isProtectedRole(o)).toBe(true);
    for (const actor of [owner, admin, lead]) {
      expect(canManageRole(actor, o)).toBe(false);
      expect(canEditRole(actor, o, o.permissions).ok).toBe(false);
    }
  });

  it('only the Owner manages the Admin preset and roles with finance or owner-only permissions', () => {
    const adminRole = preset('admin');
    const finance = preset('finance_manager');
    expect(roleNeedsOwner(adminRole)).toBe(true);
    expect(roleNeedsOwner(finance)).toBe(true);
    expect(canManageRole(owner, adminRole)).toBe(true);
    expect(canManageRole(owner, finance)).toBe(true);
    expect(canManageRole(admin, adminRole)).toBe(false);
    expect(canManageRole(admin, finance)).toBe(false);
    // Even an admin holding every non-finance permission cannot add finance permissions to a role.
    const r = canEditRole(admin, { key: 'custom', permissions: ['projects.read'] }, ['projects.read', 'finance.read']);
    expect(r.ok).toBe(false);
  });

  it('no escalation: a manager cannot grant or add permissions they do not hold', () => {
    const creator = preset('creator');
    expect(canManageRole(lead, creator)).toBe(creator.permissions.every((p) => lead.grants[0]!.permissions.has(p)));
    expect(canEditRole(lead, { key: 'custom', permissions: [] }, ['workspace.update']).ok).toBe(false);
    expect(canEditRole(lead, { key: 'custom', permissions: [] }, ['projects.read']).ok).toBe(true);
    expect(canManagePermission(lead, 'finance.read')).toBe(false);
    expect(canManagePermission(owner, 'finance.manage')).toBe(true);
  });

  it('unknown permissions are rejected, even for the Owner', () => {
    const r = canEditRole(owner, { key: 'custom', permissions: [] }, ['projects.read', 'projects.teleport']);
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('projects.teleport') });
  });

  it('property: canEditRole succeeds for a non-owner exactly when every resulting permission is manageable', () => {
    const perms = fc.subarray([...ALL_PERMISSIONS] as string[], { maxLength: 40 });
    fc.assert(
      fc.property(perms, perms, (held, after) => {
        const actor = snapshot({ perms: held });
        const role = { key: 'custom', permissions: [] as string[] };
        const expected = after.every((p) => !isFinancePermission(p) && !['finance.manage', 'ownership.transfer', 'trash.purge'].includes(p) && held.includes(p));
        expect(canEditRole(actor, role, after).ok).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  it('patterns expand to catalog permissions; a pattern is manageable only when all of it is', () => {
    const fin = expandPermissionPattern('finance.*');
    expect(fin.length).toBeGreaterThan(1);
    expect(fin.every((p) => p.startsWith('finance.'))).toBe(true);
    expect(expandPermissionPattern('projects.read')).toEqual(['projects.read']);
    expect(expandPermissionPattern('nothing.*')).toEqual([]);
    expect(expandPermissionPattern('projects.teleport')).toEqual([]);
    expect(canManagePattern(owner, 'finance.*')).toBe(true);
    expect(canManagePattern(admin, 'finance.*')).toBe(false);
    expect(canManagePattern(admin, 'projects.*')).toBe(true);
    expect(canManagePattern(admin, 'nothing.*')).toBe(false);
  });

  it('sensitive roles are flagged (finance, OFM contacts, restricted media, exports, Admin)', () => {
    expect(isSensitiveRole(preset('admin'))).toBe(true);
    expect(isSensitiveRole(preset('finance_manager'))).toBe(true);
    expect(isSensitiveRole({ key: 'x', permissions: ['exports.create'] })).toBe(true);
    expect(isSensitiveRole({ key: 'x', permissions: ['projects.read', 'tasks.read'] })).toBe(false);
  });

  it('diff and normalisation are canonical', () => {
    const d = diffPermissions(['projects.read', 'finance.read'], ['projects.read', 'tasks.read', 'exports.create']);
    expect(d.added).toEqual(['exports.create', 'tasks.read']);
    expect(d.removed).toEqual(['finance.read']);
    expect(d.sensitiveAdded).toEqual(['exports.create']);
    expect(d.sensitiveRemoved).toEqual(['finance.read']);
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...(ALL_PERMISSIONS as string[])), { maxLength: 60 }), (list) => {
        const n = normalizePermissions(list);
        expect(new Set(n).size).toBe(n.length);
        expect(normalizePermissions(n)).toEqual(n);
        expect(new Set(n)).toEqual(new Set(list));
        const dd = diffPermissions(list, n);
        expect(dd.added).toEqual([]);
        expect(dd.removed).toEqual([]);
        expect(dd.sensitiveAdded.every(isSensitivePermission)).toBe(true);
      }),
    );
  });
});

describe('manager hierarchy', () => {
  it('rejects self-management and cycles, allows valid chains', () => {
    const managerOf = new Map<string, string | null>([
      ['b', 'a'],
      ['c', 'b'],
      ['a', null],
    ]);
    expect(createsManagerCycle(managerOf, 'a', 'a')).toBe(true);
    expect(createsManagerCycle(managerOf, 'a', 'c')).toBe(true);
    expect(createsManagerCycle(managerOf, 'c', 'a')).toBe(false);
    expect(createsManagerCycle(managerOf, 'a', null)).toBe(false);
  });

  it('property: applying only changes accepted by createsManagerCycle keeps the hierarchy acyclic', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const changes = fc.array(fc.tuple(fc.constantFrom(...ids), fc.option(fc.constantFrom(...ids), { nil: null })), { maxLength: 40 });
    fc.assert(
      fc.property(changes, (list) => {
        const managerOf = new Map<string, string | null>(ids.map((i) => [i, null]));
        for (const [member, manager] of list) if (!createsManagerCycle(managerOf, member, manager)) managerOf.set(member, manager);
        for (const start of ids) {
          const seen = new Set<string>();
          let cur: string | null = start;
          while (cur) {
            expect(seen.has(cur)).toBe(false);
            seen.add(cur);
            cur = managerOf.get(cur) ?? null;
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('member visibility (scope before pagination)', () => {
  it('workspace readers see everyone; nobody without the permission sees others', () => {
    expect(memberVisibility(snapshot({ perms: ['members.read'] }), 'members.read')).toEqual({ kind: 'all' });
    expect(memberVisibility(snapshot({ perms: ['projects.read'] }), 'members.read')).toEqual({ kind: 'none' });
    expect(memberVisibility(owner, 'members.read')).toEqual({ kind: 'all' });
  });

  it('includeSelf keeps the member visible to themself without widening anything else', () => {
    const v = memberVisibility(snapshot({ perms: ['projects.read'] }), 'members.read', { includeSelf: true });
    expect(v).toEqual({ kind: 'scoped', projectIds: [], accountIds: [], directionIds: [], selfId: 'm1' });
  });

  it('direction-scoped readers see that direction, minus denied directions', () => {
    const s = snapshot({ perms: ['members.read'], scopeType: 'direction', scopeId: 'd1' });
    const v = memberVisibility(s, 'members.read');
    expect(v.kind).toBe('scoped');
    if (v.kind === 'scoped') expect(v.directionIds).toEqual(['d1']);
    const denied = memberVisibility({ ...s, denies: [{ permission: 'members.read', objectType: 'direction', objectId: 'd1' }] }, 'members.read');
    if (denied.kind === 'scoped') expect(denied.directionIds).toEqual([]);
  });

  it('inactive members see nobody', () => {
    expect(memberVisibility(snapshot({ perms: ['members.read'], membershipStatus: 'suspended' }), 'members.read', { includeSelf: true })).toEqual({ kind: 'none' });
  });
});
