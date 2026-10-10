import { z } from 'zod';
import {
  PRODUCT_LIMITS,
  productStatusSchema,
  productTagsSchema,
  productCreateRequestSchema,
  productUpdateRequestSchema,
  type ProductCreateRequest,
  type ProductUpdateRequest,
} from '@marketplace-sandbox/contracts';

type ProductStatus = z.infer<typeof productStatusSchema>;

export type ParseResult<T> =
  { ok: true; value: T } | { ok: false; fields: string[] };

const failure = (error: z.ZodError): { ok: false; fields: string[] } => {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys')
      for (const key of issue.keys) fields.add(key);
    else fields.add(issue.path.length > 0 ? String(issue.path[0]) : '(body)');
  }
  return { ok: false, fields: [...fields] };
};

const parseWith = <S extends z.ZodType>(
  schema: S,
  raw: unknown,
): ParseResult<z.output<S>> => {
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failure(parsed.error);
};

/** Create body (AS-01, AS-02): strict, trimmed, code-point limits, tags normalised. */
export const parseCreateInput = (
  raw: unknown,
): ParseResult<ProductCreateRequest> =>
  parseWith(productCreateRequestSchema, raw);

/** Update body (AS-08): `expectedVersion` plus at least one field; no `null`; no immutable field. */
export const parseUpdateInput = (
  raw: unknown,
): ParseResult<ProductUpdateRequest> =>
  parseWith(productUpdateRequestSchema, raw);

export interface ListQuery {
  status: ProductStatus;
  category: string | null;
  inStock: boolean | null;
  limit: number;
  cursor: string | null;
}

const LIST_KEYS = new Set(['status', 'category', 'inStock', 'limit', 'cursor']);

/**
 * List query (AS-14, AS-15): strict, every value a single string. Default `status` is `ACTIVE`, default `limit` 20;
 * `offset`, `page` and any unknown parameter are refused.
 */
export function parseListQuery(
  raw: Record<string, unknown>,
): ParseResult<ListQuery> {
  const fields: string[] = [];
  for (const key of Object.keys(raw)) if (!LIST_KEYS.has(key)) fields.push(key);
  const single = (key: string): string | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      fields.push(key);
      return undefined;
    }
    return value;
  };

  const statusRaw = single('status');
  let status: ProductStatus = 'ACTIVE';
  if (statusRaw !== undefined) {
    if (productStatusSchema.safeParse(statusRaw).success)
      status = statusRaw as ProductStatus;
    else fields.push('status');
  }

  const categoryRaw = single('category');
  let category: string | null = null;
  if (categoryRaw !== undefined) {
    const trimmed = categoryRaw.trim();
    const length = [...trimmed].length;
    if (
      length < PRODUCT_LIMITS.category.min ||
      length > PRODUCT_LIMITS.category.max
    )
      fields.push('category');
    else category = trimmed;
  }

  const inStockRaw = single('inStock');
  let inStock: boolean | null = null;
  if (inStockRaw !== undefined) {
    if (inStockRaw === 'true') inStock = true;
    else if (inStockRaw === 'false') inStock = false;
    else fields.push('inStock');
  }

  const limitRaw = single('limit');
  let limit: number = PRODUCT_LIMITS.pageLimit.default;
  if (limitRaw !== undefined) {
    const n = /^\d{1,4}$/.test(limitRaw) ? Number(limitRaw) : NaN;
    if (
      !Number.isInteger(n) ||
      n < PRODUCT_LIMITS.pageLimit.min ||
      n > PRODUCT_LIMITS.pageLimit.max
    )
      fields.push('limit');
    else limit = n;
  }

  const cursorRaw = single('cursor');
  if (cursorRaw !== undefined && (cursorRaw === '' || cursorRaw.length > 512))
    fields.push('cursor');

  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return {
    ok: true,
    value: { status, category, inStock, limit, cursor: cursorRaw ?? null },
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value);

/**
 * `?ids=a,b,c` of the batch route (AS-38): 1 to `max` well-formed UUIDs, request order and duplicates kept (a repeated
 * id repeats its item). Anything else is a validation failure of the field `ids`.
 */
export function parseBatchIds(
  raw: unknown,
  max: number = PRODUCT_LIMITS.batchRouteIds,
): ParseResult<string[]> {
  if (typeof raw !== 'string' || raw.length === 0)
    return { ok: false, fields: ['ids'] };
  const ids = raw.split(',');
  if (ids.length > max || !ids.every(isUuid))
    return { ok: false, fields: ['ids'] };
  return { ok: true, value: ids.map((id) => id.toLowerCase()) };
}

/** Tags alone (AS-01): trimmed, lower-cased, de-duplicated with the first occurrence kept; 1–50 code points; ≤ 32. */
export const normalizeTags = (raw: unknown[]): ParseResult<string[]> =>
  parseWith(productTagsSchema, raw);
