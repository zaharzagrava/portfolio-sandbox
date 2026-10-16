/**
 * One catalog record of an import file (CSV cells or JSON values) to the catalog's import item (S07 D-21). Only the
 * structural rules live here (presence, types, decimal shape); lengths, price > 0 and tag counts are the catalog's.
 * Prices are major units in the file and become integer minor units by digit arithmetic, never floating point.
 */
export const DEFAULT_BRAND = 'Unbranded';

export const REQUIRED_COLUMNS = ['sku', 'title', 'price', 'category'] as const;
export const OPTIONAL_COLUMNS = [
  'description',
  'brand',
  'stock',
  'tags',
] as const;
const KNOWN = new Set<string>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);

export type RowField =
  | 'sku'
  | 'title'
  | 'price'
  | 'category'
  | 'description'
  | 'brand'
  | 'stock'
  | 'tags'
  | '';
export type RowProblemCode =
  'missing_required' | 'invalid_price' | 'invalid_stock' | 'invalid_type';
export interface RowProblem {
  field: string;
  code: string;
}

/** The item `ProductImportService.upsertFromExternal` takes. */
export interface ParsedItem {
  externalSku: string;
  title: string;
  description?: string;
  brand: string;
  category: string;
  priceMinor: number;
  quantity?: number;
  tags?: string[];
}

export type RowResult =
  { ok: true; item: ParsedItem } | { ok: false; problems: RowProblem[] };

const isBlank = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

const PRICE = /^(\d{1,9})(?:\.(\d{1,2}))?$/;
const STOCK = /^\d{1,7}$/;
const MAX_STOCK = 1_000_000;

export function parsePriceMinor(
  value: unknown,
):
  | { ok: true; minor: number }
  | { ok: false; code: 'missing_required' | 'invalid_price' | 'invalid_type' } {
  if (isBlank(value)) return { ok: false, code: 'missing_required' };
  let text: string;
  if (typeof value === 'string') text = value.trim();
  else if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false, code: 'invalid_price' };
    text = String(value);
  } else return { ok: false, code: 'invalid_type' };
  const m = PRICE.exec(text);
  if (!m) return { ok: false, code: 'invalid_price' };
  const cents = (m[2] ?? '').padEnd(2, '0');
  return { ok: true, minor: Number(m[1]) * 100 + Number(cents) };
}

/** An empty or absent stock means "do not touch stock" (`quantity` undefined). */
export function parseStock(
  value: unknown,
):
  | { ok: true; quantity: number | undefined }
  | { ok: false; code: 'invalid_stock' | 'invalid_type' } {
  if (isBlank(value)) return { ok: true, quantity: undefined };
  let n: number;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!STOCK.test(text)) return { ok: false, code: 'invalid_stock' };
    n = Number(text);
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0)
      return { ok: false, code: 'invalid_stock' };
    n = value;
  } else return { ok: false, code: 'invalid_type' };
  return n > MAX_STOCK
    ? { ok: false, code: 'invalid_stock' }
    : { ok: true, quantity: n };
}

/** `a|b| c ` or a JSON array of strings; empties are dropped. `null` when the value has no tags shape. */
export function parseTags(value: unknown): string[] | null {
  const parts: unknown[] | null =
    typeof value === 'string'
      ? value.split('|')
      : Array.isArray(value)
        ? value
        : isBlank(value)
          ? []
          : null;
  if (!parts || parts.some((p) => typeof p !== 'string')) return null;
  return (parts as string[]).map((p) => p.trim()).filter((p) => p !== '');
}

type Text =
  | { ok: true; value: string | undefined }
  | { ok: false; code: 'missing_required' | 'invalid_type' };

function text(value: unknown, required: boolean): Text {
  if (isBlank(value))
    return required
      ? { ok: false, code: 'missing_required' }
      : { ok: true, value: undefined };
  if (typeof value !== 'string') return { ok: false, code: 'invalid_type' };
  return { ok: true, value: value.trim() };
}

/** `record` is keyed by the normalised column name (trimmed, lower-case). */
export function parseRecord(record: Record<string, unknown>): RowResult {
  const problems: RowProblem[] = [];
  const sku = text(record.sku, true);
  const title = text(record.title, true);
  const category = text(record.category, true);
  const description = text(record.description, false);
  const brand = text(record.brand, false);
  for (const [field, r] of [
    ['sku', sku],
    ['title', title],
    ['price', parsePriceMinor(record.price)],
    ['category', category],
    ['stock', parseStock(record.stock)],
    ['description', description],
    ['brand', brand],
  ] as const) {
    if (!r.ok) problems.push({ field, code: r.code });
  }
  const tags = parseTags(record.tags);
  if (tags === null) problems.push({ field: 'tags', code: 'invalid_type' });
  if (problems.length > 0) return { ok: false, problems };

  const price = parsePriceMinor(record.price) as { ok: true; minor: number };
  const stock = parseStock(record.stock) as {
    ok: true;
    quantity: number | undefined;
  };
  const item: ParsedItem = {
    externalSku: (sku as { value: string }).value,
    title: (title as { value: string }).value,
    category: (category as { value: string }).value,
    brand: (brand as Text & { ok: true }).value || DEFAULT_BRAND,
    priceMinor: price.minor,
  };
  const d = (description as Text & { ok: true }).value;
  if (d !== undefined) item.description = d;
  if (stock.quantity !== undefined) item.quantity = stock.quantity;
  if (record.tags !== undefined && tags) item.tags = tags;
  return { ok: true, item };
}

const CATALOG_TO_COLUMN: Record<string, string> = {
  priceMinor: 'price',
  quantity: 'stock',
  externalSku: 'sku',
};
/** The catalog names its fields `externalSku`, `priceMinor`, `quantity`; the file names them `sku`, `price`, `stock`. */
export const catalogFieldToColumn = (field: string): string =>
  CATALOG_TO_COLUMN[field] ?? field;

export const normaliseColumns = (raw: string[]): string[] =>
  raw.map((c) => c.trim().toLowerCase());

export type HeaderCheck =
  | { ok: true; ignored: string[] }
  | { ok: false; missing: string[]; repeated: string[] };

/** `columns` are already normalised. Optional columns may be missing; unknown ones are ignored and named once. */
export function checkHeader(columns: string[]): HeaderCheck {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const c of columns) {
    if (seen.has(c)) repeated.add(c);
    seen.add(c);
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !seen.has(c));
  if (missing.length > 0 || repeated.size > 0)
    return { ok: false, missing: [...missing], repeated: [...repeated] };
  return { ok: true, ignored: [...seen].filter((c) => !KNOWN.has(c)) };
}

/** The unknown keys of a JSON-lines object. */
export const unknownKeys = (record: Record<string, unknown>): string[] =>
  Object.keys(record)
    .map((k) => k.trim().toLowerCase())
    .filter((k) => !KNOWN.has(k));

/** JSON keys, normalised like CSV headers (a later duplicate after normalisation replaces the earlier). */
export function normaliseKeys(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) out[k.trim().toLowerCase()] = v;
  return out;
}
