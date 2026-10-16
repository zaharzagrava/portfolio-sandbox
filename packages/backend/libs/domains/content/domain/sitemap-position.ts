/** Protocol limit of one sitemap file. */
export const MAX_URLS_PER_FILE = 50_000;

/** Positions start at 1 and never change or repeat; a page is a stable range of positions (S27 FR-051). */
export const pageOfPosition = (position: number, capacity: number): number =>
  Math.floor((position - 1) / capacity);

export const pageRange = (
  page: number,
  capacity: number,
): { from: number; to: number } => ({
  from: page * capacity + 1,
  to: (page + 1) * capacity,
});

/** The last page that can hold a story; page 0 when nothing was ever published (the index lists one empty child). */
export const lastPage = (
  highestPosition: number | null,
  capacity: number,
): number =>
  highestPosition === null || highestPosition < 1
    ? 0
    : pageOfPosition(highestPosition, capacity);

/** A page number in a sitemap file name: canonical decimal, at most 9 digits; anything else is not a page. */
export function parsePageNumber(text: string): number | null {
  return /^(0|[1-9]\d{0,8})$/.test(text) ? Number(text) : null;
}
