/**
 * Wait text for a `429` (W01 FR-041): below a minute "{n} seconds", below an hour whole minutes rounded up, otherwise whole
 * hours rounded up. `null` when the header was missing, so the sentence ends "Try again later." instead.
 */
export function formatWait(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (seconds < 60) return unit(Math.max(1, Math.ceil(seconds)), 'second');
  if (seconds < 3600) return unit(Math.ceil(seconds / 60), 'minute');
  return unit(Math.ceil(seconds / 3600), 'hour');
}

/** The wait as it reads inside "Try again in {wait}": W01's wording, or "a moment" when the server gave none (W05 FR-063). */
export function waitPhrase(seconds: number | null | undefined): string {
  return formatWait(seconds) ?? 'a moment';
}

/** "{subject}. Try again in {wait}." or "{subject}. Try again later." */
export function waitSentence(subject: string, seconds: number | null | undefined): string {
  const wait = formatWait(seconds);
  return wait ? `${subject}. Try again in ${wait}.` : `${subject}. Try again later.`;
}
