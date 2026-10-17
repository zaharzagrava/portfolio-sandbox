import { InvalidIdempotencyKeyError } from './idempotency-errors';

export const MAX_KEY_LENGTH = 512;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Reject an unusable key before any store call (1 to 512 characters, no control characters). */
export function assertValidKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0)
    throw new InvalidIdempotencyKeyError('idempotency key is empty');
  if (key.length > MAX_KEY_LENGTH)
    throw new InvalidIdempotencyKeyError(
      `idempotency key is longer than ${MAX_KEY_LENGTH} characters`,
    );
  if (CONTROL.test(key))
    throw new InvalidIdempotencyKeyError(
      'idempotency key contains a control character',
    );
}

/**
 * The key of a piece of work from its business identity. Work owned by a tenant MUST pass the tenant (shop) first, so
 * one tenant's record never replays for another. Parts are escaped, so `('a#b', 'c')` and `('a', 'b#c')` differ.
 */
export function idempotencyKey(...parts: string[]): string {
  if (parts.length === 0)
    throw new InvalidIdempotencyKeyError('idempotency key has no part');
  const key = parts
    .map((part) => {
      if (typeof part !== 'string' || part.length === 0)
        throw new InvalidIdempotencyKeyError(
          'idempotency key has an empty part',
        );
      return part.replace(/%/g, '%25').replace(/#/g, '%23');
    })
    .join('#');
  assertValidKey(key);
  return key;
}
