import { catalogFieldToColumn, type RowProblem } from './import-row';

/** The report is a CSV with this header, one line per problem, in file order (S07 FR-031). */
export const REPORT_HEADER = 'row,sku,field,code,message';

/** Codes this domain writes itself; the catalog's own code (`invalid`) is passed through unchanged. */
export const REPORT_CODES = [
  'missing_required',
  'invalid_price',
  'invalid_stock',
  'invalid_type',
  'row_too_large',
  'invalid_record',
  'invalid',
] as const;

const MESSAGES: Record<(typeof REPORT_CODES)[number], string> = {
  missing_required: 'This column is required and the cell is empty.',
  invalid_price:
    'The price must be a decimal number such as 12.99, with at most two decimals.',
  invalid_stock: 'The stock must be a whole number from 0 to 1,000,000.',
  invalid_type: 'The value has the wrong type for this column.',
  row_too_large: 'The record is larger than 1 MiB and was skipped.',
  invalid_record: 'The line is not a JSON object and was skipped.',
  invalid: 'The catalog refused this value.',
};

const CATALOG_MESSAGES: Record<string, string> = {
  sku: 'The catalog refused the SKU (1 to 128 characters).',
  title: 'The catalog refused the title (1 to 200 characters).',
  description:
    'The catalog refused the description (at most 4,000 characters).',
  brand: 'The catalog refused the brand (1 to 100 characters).',
  category: 'The catalog refused the category (1 to 100 characters).',
  price: 'The catalog refused the price (it must be greater than zero).',
  stock: 'The catalog refused the stock (0 to 1,000,000,000).',
  tags: 'The catalog refused the tags (at most 32, each 1 to 50 characters).',
};

const GENERIC = 'The catalog refused this value.';

/** `field` is the file's column name. A code with no entry still prints a generic message. */
export function messageFor(code: string, field: string): string {
  if (code === 'invalid') return CATALOG_MESSAGES[field] ?? GENERIC;
  return (MESSAGES as Record<string, string>)[code] ?? GENERIC;
}

const FORMULA = /^[=+\-@\t\r]/;

/** A leading apostrophe keeps a spreadsheet from evaluating a cell that starts like a formula. */
export const guardCell = (value: string): string =>
  FORMULA.test(value) ? `'${value}` : value;

const csvCell = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

export interface ReportRow {
  row: number;
  sku: string;
  /** Problems with the file's column names (`title`) or the catalog's field names (`priceMinor`). */
  problems: RowProblem[];
}

/** One CSV line (with its newline) per problem of the record. */
export function reportLines({ row, sku, problems }: ReportRow): string[] {
  return problems.map((problem) => {
    const field = catalogFieldToColumn(problem.field);
    return (
      [
        String(row),
        csvCell(guardCell(sku)),
        csvCell(field),
        csvCell(problem.code),
        csvCell(messageFor(problem.code, field)),
      ].join(',') + '\n'
    );
  });
}
