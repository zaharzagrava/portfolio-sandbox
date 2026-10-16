export const FILE_NAME_MAX = 120;
const FALLBACK = 'catalog';

/**
 * The name shown for an upload (S07 FR-014): control and line-separator characters, path separators and quotes are
 * removed, leading dots and blanks go, and it is cut to 120 code points; an empty result is `catalog`. It never enters
 * a storage key.
 */
export function sanitiseFileName(raw: string): string {
  const cleaned = raw
    .replace(/[\p{Cc}\p{Zl}\p{Zp}/\\"'`]/gu, '')
    .trim()
    .replace(/^[.\s]+/, '');
  const cut = [...cleaned].slice(0, FILE_NAME_MAX).join('').trim();
  return cut === '' || /^\.+$/.test(cut) ? FALLBACK : cut;
}

/** `errors-<name>.csv` for the report download, at most 120 characters, without doubling the extension. */
export function errorReportDownloadName(displayName: string): string {
  const base = sanitiseFileName(displayName).replace(
    /\.(csv|jsonl|json|txt)$/i,
    '',
  );
  const room = FILE_NAME_MAX - 'errors-'.length - '.csv'.length;
  return `errors-${[...base].slice(0, room).join('')}.csv`;
}
