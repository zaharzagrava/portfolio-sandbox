/**
 * Dates of the orders screens are formatted in UTC so the server render and the browser agree (no hydration mismatch);
 * the `<time>` element carries the exact instant and the full text as its title (W03 AS-55).
 */
const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const MOMENT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

const valid = (iso: string): Date | null => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const formatPlaced = (iso: string): string => {
  const date = valid(iso);
  return date ? DAY.format(date) : iso;
};

export const formatMoment = (iso: string): string => {
  const date = valid(iso);
  return date ? `${MOMENT.format(date)} UTC` : iso;
};
