/**
 * CSV cells of the statement export (S16 FR-041). Text cells are formula-safe: a value that starts with `=`, `+`,
 * `-`, `@`, a tab or a carriage return gets a leading `'` and is quoted; other text is quoted only when RFC 4180
 * needs it. Integer columns are written bare, so `-900` stays `-900` and never becomes `'-900`.
 */
export const CSV_COLUMNS = [
  'rowType',
  'orderId',
  'lineId',
  'paidAt',
  'productId',
  'category',
  'quantity',
  'unitPriceMinor',
  'lineTotalMinor',
  'rateBps',
  'commissionMinor',
  'refersToMonth',
  'bookedMonth',
  'cause',
] as const;

export const CSV_HEADER = `${CSV_COLUMNS.join(',')}\r\n`;

const DANGEROUS = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function csvText(value: string | null): string {
  if (value === null || value === '') return '';
  if (DANGEROUS.test(value)) return `"${`'${value}`.replace(/"/g, '""')}"`;
  return NEEDS_QUOTES.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvInteger(value: number | null): string {
  if (value === null) return '';
  if (!Number.isSafeInteger(value))
    throw new RangeError('an integer column holds a safe integer');
  return String(value);
}

export const csvRow = (cells: string[]): string => `${cells.join(',')}\r\n`;
