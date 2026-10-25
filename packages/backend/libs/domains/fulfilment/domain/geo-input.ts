import type { z } from 'zod';
import {
  pickupBrowseQuerySchema,
  pickupClusterQuerySchema,
  pickupListQuerySchema,
  pickupSearchQuerySchema,
  type PickupBrowseQuery,
  type PickupClusterQuery,
  type PickupListQuery,
  type PickupSearchQuery,
} from '@marketplace-sandbox/contracts';

export type Parsed<T> =
  { ok: true; value: T } | { ok: false; fields: string[] };

/**
 * Names of the failing parameters, never their values; unknown keys at the top level are named too. Unknown keys inside
 * a nested value name the parent (the union of opening hours reports the keys of its first branch, which are valid).
 */
export const fieldsOf = (error: z.ZodError): string[] => [
  ...new Set(
    error.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys' && issue.path.length === 0
        ? issue.keys
        : [String(issue.path[0] ?? 'query')],
    ),
  ),
];

const parseWith =
  <S extends z.ZodType>(schema: S) =>
  (raw: unknown): Parsed<z.output<S>> => {
    const parsed = schema.safeParse(raw);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, fields: fieldsOf(parsed.error) };
  };

/** `GET /search/near` (S19 FR-022): strict, nothing clamped, blank `q` is absent. */
export const parseNearQuery: (raw: unknown) => Parsed<PickupSearchQuery> =
  parseWith(pickupSearchQuerySchema);

/** `GET /pickup-points/near`. */
export const parseBrowseQuery: (raw: unknown) => Parsed<PickupBrowseQuery> =
  parseWith(pickupBrowseQuerySchema);

/** `GET /pickup-points/clusters` (S19 FR-026): `bbox` is `top,left,bottom,right`, `left > right` crosses ±180°. */
export const parseClusterQuery: (raw: unknown) => Parsed<PickupClusterQuery> =
  parseWith(pickupClusterQuerySchema);

/** Seller listings. */
export const parseListQuery: (raw: unknown) => Parsed<PickupListQuery> =
  parseWith(pickupListQuerySchema);
