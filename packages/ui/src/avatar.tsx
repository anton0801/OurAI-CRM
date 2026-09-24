import { cn } from './cn';

const PALETTE = ['#1f8a64', '#3b6fb0', '#b7791f', '#b5657a', '#5f6f7e', '#6d5bb0', '#2f7f8a', '#8a5a2f'];

const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?';

/** Photo or initials on a deterministic background. Sizes: 24/28 rows, 36 lists, 64 profile. */
export const Avatar = ({
  name,
  src,
  size = 28,
  className,
  decorative = false,
}: {
  name: string;
  src?: string | null;
  size?: 24 | 28 | 32 | 36 | 40 | 64 | 80;
  className?: string;
  decorative?: boolean;
}) => {
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) };
  if (src)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={decorative ? '' : name}
        width={size}
        height={size}
        loading="lazy"
        className={cn('shrink-0 rounded-full object-cover', className)}
        style={style}
      />
    );
  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
      className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white', className)}
      style={{ ...style, backgroundColor: PALETTE[hash(name) % PALETTE.length] }}
    >
      {initials(name)}
    </span>
  );
};
