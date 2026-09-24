import { z } from 'zod';
import {
  CHANGE_SOURCES,
  LIMITS,
  PAGE_SIZE_MAX,
  isDecimalString,
  isIsoDate,
  isSafeUrl,
  isSupportedCurrency,
  isValidTimeZone,
} from '@castlane/domain';

export const uuid = z.string().uuid();
export const id = uuid;
export const isoDateTime = z.string().datetime({ offset: true });
export const isoDate = z.string().refine(isIsoDate, 'Use the YYYY-MM-DD format.');
export const timezone = z.string().refine(isValidTimeZone, 'Choose a valid IANA time zone.');
export const currencyCode = z.string().length(3).refine(isSupportedCurrency, 'Unsupported currency.');
/** Decimal amount as a string (never a float). */
export const decimalString = z.string().refine(isDecimalString, 'Enter a decimal number.');
export const money = z.object({ amount: decimalString, currency: currencyCode });
export type Money = z.infer<typeof money>;
export const percent = z
  .string()
  .refine((v) => isDecimalString(v) && Number(v) >= 0 && Number(v) <= 100 && (v.split('.')[1] ?? '').length <= 4, 'Enter a percentage between 0 and 100 with at most 4 decimals.');

export const shortName = z.string().trim().min(LIMITS.shortNameMin).max(LIMITS.shortNameMax);
export const taskTitle = z.string().trim().min(LIMITS.taskTitleMin).max(LIMITS.taskTitleMax);
export const note = z.string().max(LIMITS.noteMax);
export const reason = z.string().trim().min(LIMITS.reasonMin).max(LIMITS.reasonMax);
export const optionalReason = z.string().trim().max(LIMITS.reasonMax).optional();
export const safeUrl = z.string().trim().max(LIMITS.urlMax).refine((v) => isSafeUrl(v), 'Enter a valid http(s) link.');
export const httpsUrl = z.string().trim().max(LIMITS.urlMax).refine((v) => isSafeUrl(v, { httpsOnly: true }), 'Enter a valid https link.');
export const tag = z.string().trim().min(LIMITS.tagMin).max(LIMITS.tagMax);
export const tags = z.array(tag).max(LIMITS.tagsPerObject);

export const workspaceParams = z.object({ workspaceId: uuid });
export const wsId = <T extends z.ZodRawShape>(shape: T) => z.object({ workspaceId: uuid, ...shape });

export const pageQuery = z.object({
  cursor: z.string().max(2000).optional(),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
});

export const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable(), hasMore: z.boolean() });

/** Comma-separated list in query strings (?status=a,b). */
export const csv = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(item).max(200));

export const boolQuery = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

export const memberRef = z.object({
  membershipId: uuid,
  displayName: z.string(),
  avatarUrl: z.string().nullable().optional(),
  former: z.boolean().optional(),
});
export type MemberRef = z.infer<typeof memberRef>;

export const okResponse = z.object({ ok: z.literal(true) });
export const changeSource = z.enum(CHANGE_SOURCES);
export const versioned = z.object({ id: uuid, rowVersion: z.number().int() });

/** Standard archive / impact preview item. */
export const impactItem = z.object({
  kind: z.string(),
  label: z.string(),
  count: z.number().int(),
  blocking: z.boolean(),
  resolution: z.string().optional(),
});
export type ImpactItem = z.infer<typeof impactItem>;
