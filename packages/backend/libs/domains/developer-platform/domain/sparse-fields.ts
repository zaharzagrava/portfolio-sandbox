import { ApiError } from './errors';

export const EXPAND_ALLOWED = ['shop'] as const;
export const EXPAND_MAX = 3;

/**
 * `fields=a,b` against the field names of the requested version. `null` = no restriction.
 * Unknown, empty or nested names are refused (`invalid_fields`).
 */
export function parseFields(
  raw: string | undefined,
  allowed: readonly string[],
): string[] | null {
  if (raw === undefined) return null;
  const parts = raw.split(',').map((p) => p.trim());
  const bad = parts.filter((p) => p === '' || !allowed.includes(p));
  if (bad.length > 0)
    throw new ApiError('invalid_fields', 'Unknown or empty field name.', {
      errors: bad.map((b) => ({ field: 'fields', code: `unknown:${b}` })),
    });
  return [...new Set(parts)];
}

/** `expand=shop`: only `shop`, depth 1, at most 3 values. */
export function parseExpand(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const parts = raw.split(',').map((p) => p.trim());
  if (parts.length > EXPAND_MAX)
    throw new ApiError('invalid_expand', `At most ${EXPAND_MAX} expansions.`);
  const bad = parts.filter(
    (p) => !(EXPAND_ALLOWED as readonly string[]).includes(p),
  );
  if (bad.length > 0)
    throw new ApiError('invalid_expand', 'Only "shop" can be expanded.', {
      errors: bad.map((b) => ({ field: 'expand', code: `unknown:${b}` })),
    });
  return [...new Set(parts)];
}

/** Keeps only the requested top-level fields of a resource. */
export function pickFields<T extends Record<string, unknown>>(
  resource: T,
  fields: string[] | null,
): Partial<T> {
  if (!fields) return resource;
  return Object.fromEntries(
    Object.entries(resource).filter(([k]) => fields.includes(k)),
  ) as Partial<T>;
}
