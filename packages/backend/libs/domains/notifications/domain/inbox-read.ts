/**
 * An inbox item is read when its own flag is set, or when it arrived at or before the user's mark-all watermark.
 * A row written before the `arrived_at` column existed counts as arrived at its event time.
 */
export function isEffectivelyRead(
  item: { read: boolean; eventTime: Date; arrivedAt: Date | null },
  readAllBefore: Date | null,
): boolean {
  if (item.read) return true;
  if (!readAllBefore) return false;
  const arrived = item.arrivedAt ?? item.eventTime;
  return arrived.getTime() <= readAllBefore.getTime();
}
