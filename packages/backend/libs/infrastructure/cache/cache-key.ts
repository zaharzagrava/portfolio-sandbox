import { createHash } from 'node:crypto';
import { InvalidCacheKey } from './cache.errors';

export const MAX_KEY_BYTES = 512;
const NAMESPACE = /^[a-z][a-z0-9-]*$/;
// Matching control characters is the point of both patterns.
/* eslint-disable no-control-regex */
const MUST_ENCODE = /[%:{}\s\u0000-\u001f\u007f-\u009f]/gu;
const FORBIDDEN_IN_KEY = /[\s\u0000-\u001f\u007f-\u009f]/u;
/* eslint-enable no-control-regex */

const encodePart = (part: string): string =>
  part.replace(
    MUST_ENCODE,
    (ch) =>
      '%' +
      [...Buffer.from(ch, 'utf8')]
        .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
        .join('%'),
  );

/**
 * Tenant-safe key builder: `<namespace>:v<version>:<part>:…`. Parts are percent-encoded for `:`, `{`, `}`, `%`,
 * whitespace and control characters, so a caller-supplied part can neither split the key nor change its shard.
 */
export function cacheKey(
  namespace: string,
  version: number,
  ...parts: string[]
): string {
  if (!NAMESPACE.test(namespace))
    throw new InvalidCacheKey(`namespace "${namespace}" is not valid`);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new InvalidCacheKey('version must be a positive integer');
  if (parts.length === 0) throw new InvalidCacheKey('at least one part');
  const encoded = parts.map((part) => {
    if (typeof part !== 'string' || part.length === 0)
      throw new InvalidCacheKey('a key part must be a non-empty string');
    return encodePart(part);
  });
  const key = `${namespace}:v${version}:${encoded.join(':')}`;
  validateKey(key);
  return key;
}

/**
 * Non-empty, at most 512 bytes, one namespace segment before the first `:`, no whitespace, control characters or
 * braces (a brace could change the shard of the key's auxiliary records).
 */
export function validateKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0)
    throw new InvalidCacheKey('key is empty');
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES)
    throw new InvalidCacheKey(`key is longer than ${MAX_KEY_BYTES} bytes`);
  if (FORBIDDEN_IN_KEY.test(key))
    throw new InvalidCacheKey('key contains whitespace or control characters');
  if (key.includes('{') || key.includes('}'))
    throw new InvalidCacheKey('key contains a brace');
  const colon = key.indexOf(':');
  if (colon < 1 || colon === key.length - 1)
    throw new InvalidCacheKey('key needs a "<namespace>:" prefix and a body');
}

/** The first segment of a validated key (the only metric label derived from a key). */
export const keyNamespace = (key: string): string =>
  key.slice(0, key.indexOf(':'));

/** First 8 hex characters of the SHA-256 of the key: enough to correlate logs, useless to recover the key. */
export const keyDigest = (key: string): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 8);

/** Hash-tagged names of a key's auxiliary records: same slot as the entry itself (FR-020). */
export const minimumKey = (key: string): string => `{${key}}:min`;
export const recomputeLockKey = (key: string): string => `{${key}}:lock`;
