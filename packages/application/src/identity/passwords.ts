import { hash, verify } from '@node-rs/argon2';
import { AppError, LIMITS } from '@castlane/domain';
import { hmac } from '../core/crypto';

/**
 * Argon2id parameters. Tuned for ~50–100 ms on a production-class machine; re-measure with
 * `pnpm tsx apps/worker/src/cli/measure-argon2.ts` on the target hardware (see README).
 */
const PARAMS = {
  algorithm: 2 as const, // Algorithm.Argon2id (const enum; inlined for isolatedModules)
  memoryCost: Number(process.env.ARGON2_MEMORY_KIB ?? 19_456),
  timeCost: Number(process.env.ARGON2_TIME_COST ?? 2),
  parallelism: 1,
};

const peppered = (password: string): string => {
  const pepper = process.env.PASSWORD_PEPPER;
  return pepper ? hmac(pepper, password) : password;
};

export const validateNewPassword = (password: string, context: { email?: string } = {}): void => {
  if (password.length < LIMITS.passwordMin)
    throw new AppError('VALIDATION_FAILED', `Use at least ${LIMITS.passwordMin} characters.`, {
      fieldErrors: [{ field: 'password', code: 'TOO_SHORT', message: `Use at least ${LIMITS.passwordMin} characters.` }],
    });
  if (password.length > LIMITS.passwordMax)
    throw new AppError('VALIDATION_FAILED', `Use at most ${LIMITS.passwordMax} characters.`, {
      fieldErrors: [{ field: 'password', code: 'TOO_LONG', message: `Use at most ${LIMITS.passwordMax} characters.` }],
    });
  if (context.email && password.toLowerCase() === context.email.toLowerCase())
    throw new AppError('VALIDATION_FAILED', 'The password must not be your e-mail address.', {
      fieldErrors: [{ field: 'password', code: 'EQUALS_EMAIL', message: 'The password must not be your e-mail address.' }],
    });
};

export const hashPassword = (password: string): Promise<string> => hash(peppered(password), PARAMS);

export const verifyPassword = async (hashed: string, password: string): Promise<boolean> => {
  try {
    return await verify(hashed, peppered(password));
  } catch {
    return false;
  }
};

/** A precomputed hash used to keep timing similar when the account does not exist. */
let dummyHash: Promise<string> | undefined;
export const dummyVerify = async (password: string): Promise<void> => {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalisation');
  await verifyPassword(await dummyHash, password);
};
