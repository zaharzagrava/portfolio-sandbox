import type { z } from 'zod';

/** The owning capability of an upstream: the unit of breaker state, bulkhead and metrics labels. */
export type Capability =
  | 'catalog'
  | 'tenancy'
  | 'recommendations'
  | 'trending'
  | 'flags'
  | 'chat'
  | 'boards'
  | 'video'
  | 'media'
  | 'pickup'
  | 'flash-sales'
  | 'auctions'
  | 'identity';

/**
 * One declared upstream call (S48 FR-001): method, path, contract schema, identity need, shared-cache eligibility.
 * The path is relative to the one configured domain-API origin; the client refuses anything that leaves it (AS-63).
 */
export interface Endpoint<T> {
  /** Metric label and cache-key prefix. */
  name: string;
  upstream: Capability;
  method: 'GET' | 'POST';
  /** Starts with `/api/`; values are already encoded. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  schema: z.ZodType<T>;
  /** `required`: the caller must have a token (the section is skipped otherwise); `optional`: attach when present. */
  identity: 'none' | 'optional' | 'required';
  /** Forward a valid `X-Anonymous-Id` (flags only). */
  anonymousId?: boolean;
  /** Eligible for the shared cache when the upstream marks the answer shared-cacheable. Never with identity. */
  sharedCache: boolean;
  /** Feeds the per-upstream breaker (optional sections; the required product call and identity relays do not). */
  breaker: boolean;
  /** Extra request headers from the allowlist (identity relays: `x-forwarded-for`). */
  headers?: Record<string, string>;
}

export const enc = encodeURIComponent;
