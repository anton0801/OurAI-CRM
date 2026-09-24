/**
 * Display formatting. Canonical values stay untouched (ISO strings, decimal strings); only the
 * presentation is localised. Missing values render as an explicit "Not provided", never 0.
 */
export const NOT_PROVIDED = 'Not provided';

export const formatNumber = (v: number | string | null | undefined, opts: Intl.NumberFormatOptions = {}, locale = 'en-US') => {
  if (v === null || v === undefined || v === '') return NOT_PROVIDED;
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return String(v);
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2, ...opts }).format(n);
};

/** Money from a decimal string + currency, formatted without float arithmetic on the source. */
export const formatMoney = (amount: string | null | undefined, currency: string | null | undefined, locale = 'en-US') => {
  if (amount === null || amount === undefined || !currency) return NOT_PROVIDED;
  const negative = amount.startsWith('-');
  const [i, f = ''] = amount.replace('-', '').split('.');
  const grouped = new Intl.NumberFormat(locale).format(BigInt(i || '0'));
  const decimalSep = new Intl.NumberFormat(locale).format(1.5).charAt(1);
  return `${negative ? '−' : ''}${grouped}${f ? `${decimalSep}${f}` : ''} ${currency}`;
};

export const formatPercent = (v: string | number | null | undefined, digits = 1) =>
  v === null || v === undefined ? NOT_PROVIDED : `${formatNumber(v, { maximumFractionDigits: digits, minimumFractionDigits: 0 })}%`;

export const formatDateTime = (iso: string | null | undefined, timeZone?: string, locale = 'en-GB') => {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso));
};

export const formatDate = (isoOrDate: string | null | undefined, timeZone?: string, locale = 'en-GB') => {
  if (!isoOrDate) return '—';
  // Date-only values are calendar days: format them in UTC so they never shift by a zone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrDate)) return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${isoOrDate}T00:00:00Z`));
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone }).format(new Date(isoOrDate));
};

export const formatRelative = (iso: string | null | undefined, now = Date.now()) => {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60_000) return rtf.format(Math.round(diff / 1000), 'second');
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
};

export const formatBytes = (bytes: number | null | undefined) => {
  if (bytes === null || bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
};

export const formatDuration = (seconds: number | null | undefined) => {
  if (seconds === null || seconds === undefined) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h} h ${m.toString().padStart(2, '0')} min` : `${m} min`;
};
