/**
 * Record instants of rate beliefs (S16 FR-006, AS-07). Postgres timestamps carry microseconds and a JS `Date` only
 * milliseconds, so the instant is computed in microseconds since the epoch (`bigint`): the clock's reading, or one
 * microsecond after the last belief recorded for the same shop and category, whichever is later. A superseded belief
 * therefore always has a non-empty recorded period.
 */
export const toMicros = (date: Date): bigint => BigInt(date.getTime()) * 1000n;

export function nextRecordedMicros(
  now: Date,
  lastMicros: bigint | null,
): bigint {
  const wanted = toMicros(now);
  return lastMicros !== null && lastMicros >= wanted ? lastMicros + 1n : wanted;
}

/** `2026-04-01T09:00:00.123456Z`, the form Postgres reads back exactly. */
export function microsToIso(micros: bigint): string {
  const millis = micros / 1000n;
  const fraction = (micros % 1000n).toString().padStart(3, '0');
  const iso = new Date(Number(millis)).toISOString();
  return `${iso.slice(0, -1)}${fraction}Z`;
}

export const microsToDate = (micros: bigint): Date =>
  new Date(Number(micros / 1000n));

/** Drops a zero microsecond tail so whole milliseconds read as `…:00.123Z`. */
export const trimMicros = (value: string | null): string | null =>
  value !== null && value.endsWith('000Z') ? `${value.slice(0, -4)}Z` : value;
