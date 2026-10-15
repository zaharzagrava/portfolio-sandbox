/**
 * The time of a post or comment (W02 FR-091): "just now", "{n} minutes ago", "{n} hours ago", "{n} days ago" up to 30
 * days, then "Mon D, YYYY" (UTC, so the same instant reads the same everywhere); the exact instant is the `title`.
 */
export type DiscussionTime = { text: string; title: string; dateTime: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;

const DATE = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const EXACT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23', timeZone: 'UTC' });

export function formatDiscussionTime(iso: string, now: Date = new Date()): DiscussionTime {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { text: '', title: '', dateTime: '' };
  const elapsed = now.getTime() - at.getTime();
  let text: string;
  if (elapsed < MINUTE) text = 'just now';
  else if (elapsed < HOUR) text = unit(Math.floor(elapsed / MINUTE), 'minute');
  else if (elapsed < DAY) text = unit(Math.floor(elapsed / HOUR), 'hour');
  else if (elapsed <= 30 * DAY) text = unit(Math.floor(elapsed / DAY), 'day');
  else text = DATE.format(at);
  return { text, title: `${EXACT.format(at)} UTC`, dateTime: at.toISOString() };
}
