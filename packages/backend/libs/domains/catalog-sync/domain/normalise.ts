import { createHash } from 'node:crypto';
import { parseMinor } from './money';
import { MAX_STOCK } from './stock-merge';

/**
 * Provider-neutral normalisation vocabulary and helpers (AS-14, AS-52, FR-020, FR-024). Pure.
 * The provider-specific mappers live in `normalise-shopify.ts` and `normalise-woocommerce.ts`.
 */
export type ProviderName = 'shopify' | 'woocommerce';

export interface NormaliseContext {
  integrationId: string;
  /** Platform currency (equals the store currency, checked at connect). */
  currency: string;
  /** Decimal places of `currency` (2 for USD). */
  exponent: number;
}

export type RejectCode =
  | 'unlisted'
  | 'missing_title'
  | 'title_too_long'
  | 'external_id_too_long'
  | 'no_inventory_item'
  | 'inventory_not_tracked'
  | 'inventory_level_missing'
  | 'invalid_stock'
  | 'stock_out_of_range'
  | 'invalid_price'
  | 'invalid_updated_at'
  | 'invalid_payload';

export interface NormalisedItem {
  /** `<productId>:<variantId>` (<= 64). */
  externalId: string;
  /** `<provider>:<integrationId>:<externalId>` (<= 128). */
  externalSku: string;
  title: string;
  description: string;
  brand: string;
  category: string;
  priceMinor: number;
  currency: string;
  tags: string[];
  /** Integer in `[0, 1e9]`. */
  stock: number;
  updatedAt: Date;
  /** Digest over exactly the provider-owned fields (see `contentDigest`). */
  contentDigest: string;
}

export type NormaliseResult =
  | { ok: true; item: NormalisedItem }
  | { ok: false; code: RejectCode; externalId: string | null };

export const MAX_TITLE = 200;
export const MAX_EXTERNAL_ID = 64;
export const MAX_EXTERNAL_SKU = 128;
export const DEFAULT_CATEGORY = 'uncategorized';

export const reject = (
  code: RejectCode,
  externalId: string | null,
): NormaliseResult => ({ ok: false, code, externalId });

export interface DigestFields {
  title: string;
  description: string;
  priceMinor: number;
  category: string;
  brand: string;
  tags: readonly string[];
}

/** sha256 over exactly the provider-owned fields: title, description, price, category, brand, tags. */
export function contentDigest(fields: DigestFields): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        fields.title,
        fields.description,
        fields.priceMinor,
        fields.category,
        fields.brand,
        [...fields.tags],
      ]),
    )
    .digest('hex');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

/** Removes markup (and script/style bodies), decodes the common entities, collapses whitespace. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(
      /&(#?[a-z0-9]+);/gi,
      (m, name: string) => ENTITIES[name.toLowerCase()] ?? m,
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/** `<provider>:<integrationId>:<externalId>`, or `null` when it would exceed 128 characters. */
export function composeExternalSku(
  provider: ProviderName,
  integrationId: string,
  externalId: string,
): string | null {
  const sku = `${provider}:${integrationId}:${externalId}`;
  return sku.length <= MAX_EXTERNAL_SKU ? sku : null;
}

export type StockResult =
  | { ok: true; value: number }
  | {
      ok: false;
      code: 'invalid_stock' | 'stock_out_of_range' | 'inventory_level_missing';
    };

/** Provider stock value -> `[0, 1e9]`. Negative integers are treated as 0 (backorders). Numbers only. */
export function normaliseStock(raw: unknown): StockResult {
  if (raw === undefined || raw === null)
    return { ok: false, code: 'inventory_level_missing' };
  if (typeof raw !== 'number' || !Number.isInteger(raw))
    return { ok: false, code: 'invalid_stock' };
  if (raw > MAX_STOCK) return { ok: false, code: 'stock_out_of_range' };
  return { ok: true, value: Math.max(0, raw) };
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Provider ids arrive as numbers or strings; anything else is unusable. */
export function idString(v: unknown): string | null {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
    return String(v);
  if (typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v)) return v;
  return null;
}

/** Shared tail of both mappers: checks in a fixed order and builds the item. */
export function buildItem(input: {
  provider: ProviderName;
  ctx: NormaliseContext;
  externalId: string;
  title: string;
  description: string;
  brand: string;
  category: string;
  tags: string[];
  priceRaw: unknown;
  stockRaw: unknown;
  updatedAt: Date | null;
}): NormaliseResult {
  const { ctx, externalId } = input;
  if (input.title === '') return reject('missing_title', externalId);
  if (input.title.length > MAX_TITLE)
    return reject('title_too_long', externalId);
  if (externalId.length > MAX_EXTERNAL_ID)
    return reject('external_id_too_long', externalId);
  const externalSku = composeExternalSku(
    input.provider,
    ctx.integrationId,
    externalId,
  );
  if (externalSku === null) return reject('external_id_too_long', externalId);
  if (input.updatedAt === null) return reject('invalid_updated_at', externalId);
  const price = parseMinorLocal(input.priceRaw, ctx.exponent);
  if (price === null) return reject('invalid_price', externalId);
  const stock = normaliseStock(input.stockRaw);
  if (!stock.ok) return reject(stock.code, externalId);
  return {
    ok: true,
    item: {
      externalId,
      externalSku,
      title: input.title,
      description: input.description,
      brand: input.brand,
      category: input.category,
      priceMinor: price,
      currency: ctx.currency,
      tags: input.tags,
      stock: stock.value,
      updatedAt: input.updatedAt,
      contentDigest: contentDigest({
        title: input.title,
        description: input.description,
        priceMinor: price,
        category: input.category,
        brand: input.brand,
        tags: input.tags,
      }),
    },
  };
}

function parseMinorLocal(raw: unknown, exponent: number): number | null {
  const r = parseMinor(raw, exponent);
  return r.ok ? r.minor : null;
}

export function parseDate(raw: unknown, assumeUtc = false): Date | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const text =
    assumeUtc && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? `${raw}Z` : raw;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}
