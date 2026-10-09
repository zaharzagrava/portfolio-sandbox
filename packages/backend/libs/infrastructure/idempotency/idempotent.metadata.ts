export const IDEMPOTENT_METADATA = Symbol('idempotent');

export interface IdempotentOptions {
  /** A missing header answers `422 idempotency_key_required`. Default true. */
  required?: boolean;
  /** Record lifetime in seconds. Default 24 h, at most 7 days. */
  ttlSeconds?: number;
}
