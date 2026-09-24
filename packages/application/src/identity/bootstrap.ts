import { eq } from 'drizzle-orm';
import { systemState, userPreferences, users, withTransaction, type Db } from '@castlane/database';
import { AppError, isEmail, newId, normalizeEmail } from '@castlane/domain';
import { auditRaw } from '../core/audit';
import { randomToken } from '../core/crypto';
import { hashPassword, validateNewPassword } from './passwords';
import { createWorkspaceWithDefaults } from './workspace-defaults';

export interface BootstrapInput {
  email: string;
  displayName: string;
  /** When omitted a temporary password is generated and must be changed at first sign-in. */
  password?: string;
  at: Date;
}

/**
 * One-time creation of the first Owner (F01). Refused once bootstrap completed, so there is never
 * a default admin account in production.
 */
export const bootstrapOwner = async (
  db: Db,
  input: BootstrapInput,
): Promise<{ userId: string; workspaceId: string; temporaryPassword: string | null }> => {
  const email = normalizeEmail(input.email);
  if (!isEmail(email)) throw new AppError('VALIDATION_FAILED', 'A valid e-mail address is required.');
  const name = input.displayName.trim();
  if (name.length < 2 || name.length > 80) throw new AppError('VALIDATION_FAILED', 'Display name must be 2–80 characters.');
  const temporaryPassword = input.password ? null : `${randomToken(12)}-${randomToken(6)}`;
  const password = input.password ?? temporaryPassword!;
  validateNewPassword(password, { email });

  return withTransaction(
    db,
    async (tx) => {
      const [done] = await tx.select().from(systemState).where(eq(systemState.key, 'bootstrap')).for('update');
      if (done) throw new AppError('INVALID_STATE', 'Bootstrap already completed: the first Owner exists. Use invitations to add people.');
      const userId = newId();
      await tx.insert(users).values({
        id: userId,
        normalizedEmail: email,
        displayEmail: input.email.trim(),
        displayName: name,
        passwordHash: await hashPassword(password),
        passwordChangedAt: input.at,
        mustChangePassword: temporaryPassword !== null,
        createdAt: input.at,
        updatedAt: input.at,
      });
      await tx.insert(userPreferences).values({ userId }).onConflictDoNothing();
      const { workspaceId } = await createWorkspaceWithDefaults(tx, {
        name: 'Castlane Workspace',
        timezone: 'UTC',
        baseCurrency: 'EUR',
        ownerUserId: userId,
        ownerDisplayName: name,
        at: input.at,
      });
      await tx.insert(systemState).values({ key: 'bootstrap', value: { completedAt: input.at.toISOString(), workspaceId, ownerUserId: userId } });
      await auditRaw(tx, {
        action: 'system.bootstrap_owner',
        workspaceId,
        actorUserId: null,
        actorKind: 'system',
        entityType: 'user',
        entityId: userId,
        at: input.at,
        metadata: { temporaryPassword: temporaryPassword !== null },
      });
      return { userId, workspaceId, temporaryPassword };
    },
    { isolationLevel: 'serializable' },
  );
};
