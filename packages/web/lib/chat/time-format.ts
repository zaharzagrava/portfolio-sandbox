/**
 * Times and author labels of the chat (W05 AS-07, AS-22). Everything uses the viewer's locale and zone (spec Assumptions).
 * `now` is passed in, so the functions are pure and a component can re-render on a clock tick.
 */

const parse = (iso: string): Date | null => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const clock = (date: Date) => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** The time of a message: its clock time. */
export function messageTime(iso: string): string {
  const date = parse(iso);
  return date ? clock(date) : '';
}

/** The last-message time of an inbox row: "Just now", "2 min ago", today's time, or a date. */
export function inboxTime(iso: string | null, now: number): string {
  if (!iso) return '';
  const date = parse(iso);
  if (!date) return '';
  const diff = now - date.getTime();
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  const today = new Date(now);
  if (sameDay(date, today)) return clock(date);
  return date.getFullYear() === today.getFullYear()
    ? date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    : date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

/** The local day a message belongs to: a day separator sits where this key changes. */
export function dayKey(iso: string): string {
  const date = parse(iso);
  return date ? `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}` : '';
}

/** "Today", "Yesterday", or a date. */
export function dayLabel(iso: string, now: number): string {
  const date = parse(iso);
  if (!date) return '';
  const today = new Date(now);
  if (sameDay(date, today)) return 'Today';
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
}

/**
 * "You", "Seller" (the chat's `sellerId`) or "Buyer {first 4 characters of the id}": the API publishes no display names
 * (S24 Assumptions), so other shop staff appear as buyers until it does.
 */
export function authorLabel(authorId: string, ids: { selfId: string | null; sellerId: string }): string {
  if (authorId === ids.selfId) return 'You';
  if (authorId === ids.sellerId) return 'Seller';
  return `Buyer ${authorId.slice(0, 4)}`;
}
