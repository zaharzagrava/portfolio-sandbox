/** Keys of the thirty-day comment history: one partition per (stream, minute), sorted by comment id (time-ordered). */

export const minuteBucket = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 16).replace(/[-:T]/g, '');

export const commentPk = (streamId: string, atMs: number): string =>
  `STREAM#${streamId}#${minuteBucket(atMs)}`;

export const historyPk = (streamId: string, minute: string): string =>
  `STREAM#${streamId}#${minute}`;

/** A uuidv7 starts with its millisecond timestamp: a removal event, which carries no post time, finds the item by it. */
export function commentTimeMs(commentId: string): number {
  return parseInt(commentId.replace(/-/g, '').slice(0, 12), 16);
}

/** `yyyyMMddHHmm` is a real minute (not only twelve digits). */
export function isMinute(value: string): boolean {
  if (!/^\d{12}$/.test(value)) return false;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:00.000Z`;
  const date = new Date(iso);
  return (
    !Number.isNaN(date.getTime()) && minuteBucket(date.getTime()) === value
  );
}
