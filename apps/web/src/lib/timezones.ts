/**
 * IANA time zones offered in pickers. Browsers omit "UTC" from Intl.supportedValuesOf('timeZone'),
 * yet it is a valid stored zone (workspace default, imported deadlines) — it is always listed first.
 */
export const timeZoneList = (): string[] => {
  let list: string[] = [];
  try {
    list = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    list = [];
  }
  return list.includes('UTC') ? list : ['UTC', ...list];
};
