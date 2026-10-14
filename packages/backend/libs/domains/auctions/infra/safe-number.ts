/** BIGINT columns arrive as strings; a value outside the safe integer range is a data error, never silently rounded (III.8). */
export function safeNumber(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n))
    throw new RangeError(`amount outside the safe integer range: ${value}`);
  return n;
}
