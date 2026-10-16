/** A stored or staff-supplied locale: `xx` or `xx-XX` (S27 AS-10). */
const LOCALE = /^[a-z]{2}(-[A-Z]{2})?$/;
/** A requested locale in the public path: the same shape, in any case (`uk-ua`, `UK`). */
const REQUEST_LOCALE = /^[A-Za-z]{2}(-[A-Za-z]{2})?$/;

export const isLocale = (value: string): boolean => LOCALE.test(value);
export const isRequestLocale = (value: string): boolean =>
  REQUEST_LOCALE.test(value);

/**
 * Locale fallback chain (S27 FR-020): exact (case-insensitive) → language (`uk-UA` → `uk`) → the story default.
 * Never across regions (`pt` does not become `pt-BR`) and never the first available locale: when the default is not
 * available the answer is none. A malformed request gives none.
 */
export function localeChain(
  requested: string,
  available: readonly string[],
  fallback: string,
): string | null {
  if (!isRequestLocale(requested)) return null;
  const lower = requested.toLowerCase();
  const exact = available.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  const language = lower.split('-')[0];
  const byLanguage = available.find((l) => l.toLowerCase() === language);
  if (byLanguage) return byLanguage;
  return available.includes(fallback) ? fallback : null;
}
