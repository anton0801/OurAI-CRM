/** Serialization helpers: API payloads carry ISO timestamps and decimal strings, never floats or BigInt. */
export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
export const isoReq = (d: Date): string => d.toISOString();
export const big = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());

/** Remove keys with undefined values (keeps nulls, which are meaningful: "unknown"). */
export const compact = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
