/**
 * "YYYY-MM-DD HH:mm UTC" (W06 FR-024, R-08): a slice of `toISOString()`, no `Intl` and no locale, so the server render and the
 * browser render are identical and admins compare the same wall clock.
 */
export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return '—';
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return '—';
  const text = time.toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 16)} UTC`;
}
