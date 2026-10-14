import type { Request } from 'express';

export const IDEMPOTENT_METADATA = Symbol('idempotent');

/**
 * Wire profile of a public contract that names things differently from the platform default (S42 FR-049). Every member
 * is optional; a route that sets none behaves exactly as before.
 */
export interface IdempotentWireOptions {
  /** Accepted key format. Default: 8 to 128 characters of letters, digits, `_` and `-`. */
  keyPattern?: RegExp;
  /** Answer for a key that does not match `keyPattern`. Default `422 idempotency_key_invalid`. */
  invalidKey?: { status: number; code: string };
  /** Header set on a replay. Default `Idempotency-Replayed`. */
  replayHeader?: string;
  /** Problem codes of the two conflicts. Defaults `idempotency_key_reuse` and `idempotency_in_flight`. */
  codes?: { reuse?: string; inFlight?: string };
  /** A `4xx` answer is stored and replayed like a success; a `5xx` is still released. Default: only answers marked final are stored. */
  storeClientErrors?: boolean;
}

export interface IdempotentOptions {
  /** A missing header answers `422 idempotency_key_required`. Default true. */
  required?: boolean;
  /** Record lifetime in seconds. Default 24 h, at most 7 days. */
  ttlSeconds?: number;
  /**
   * The scope a key is unique in. Default: the calling principal (API key, user or address). A public API scopes it by
   * acting shop and route so that two shops may use the same key text.
   */
  scope?: (req: Request) => string;
  wire?: IdempotentWireOptions;
}
