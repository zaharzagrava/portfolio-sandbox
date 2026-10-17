export type FormattedInstant = {
  /** In the viewer's time zone. */
  text: string;
  /** `2026-10-17 22:30 UTC`, for the tooltip (`title`). */
  utc: string;
  /** For `<time dateTime>`. */
  iso: string;
};

type Options = { timeZone?: string; locale?: string; time?: boolean; fallback?: string };

/** A server timestamp in the viewer's zone with the UTC instant beside it (W04 assumptions, "Time"). */
export function formatInstant(value: string | null | undefined, options: Options = {}): FormattedInstant {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return { text: options.fallback ?? 'Unknown', utc: '', iso: '' };
  const text = new Intl.DateTimeFormat(options.locale, {
    dateStyle: 'medium',
    ...(options.time === false ? {} : { timeStyle: 'short' }),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
  const iso = date.toISOString();
  return { text, utc: `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`, iso };
}

/** `hh:mm:ss` of an instant ("Last updated 14:03:22"). */
export function formatClock(at: number | Date, options: { timeZone?: string; locale?: string } = {}): string {
  return new Intl.DateTimeFormat(options.locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(at);
}
