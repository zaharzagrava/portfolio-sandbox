/** Edit distance with early exit once it exceeds `max` (returns `max + 1`). */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Typo-tolerant "contains all the words" match for short lists held in the browser: each query word must equal, start,
 * or be within one edit (two for words of 7+ letters) of some word of the text.
 */
export function fuzzyMatches(text: string, query: string): boolean {
  const wanted = words(query);
  if (!wanted.length) return true;
  const have = words(text);
  return wanted.every((word) => {
    const allowed = word.length >= 7 ? 2 : word.length >= 4 ? 1 : 0;
    return have.some((candidate) => candidate.startsWith(word) || distance(word, candidate, allowed) <= allowed);
  });
}
