import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every depth, so key order and whitespace never change the fingerprint. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
    );
  return `{${entries.join(',')}}`;
}

/** Query string with its pairs sorted, so `?b=2&a=1` equals `?a=1&b=2`. */
export function canonicalQuery(rawQuery: string): string {
  const pairs = [...new URLSearchParams(rawQuery).entries()].sort(
    ([ak, av], [bk, bv]) =>
      ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1,
  );
  return new URLSearchParams(pairs).toString();
}

export interface FingerprintInput {
  method: string;
  /** Concrete path, without the query string. */
  path: string;
  rawQuery: string;
  body: unknown;
}

/** SHA-256 hex over method, concrete path, sorted query and canonical body (text and binary bodies are hashed as bytes). */
export function requestFingerprint({
  method,
  path,
  rawQuery,
  body,
}: FingerprintInput): string {
  const hash = createHash('sha256');
  hash.update(
    `${method.toUpperCase()}\n${path}\n${canonicalQuery(rawQuery)}\n`,
  );
  if (Buffer.isBuffer(body) || typeof body === 'string') hash.update(body);
  else if (body !== undefined) hash.update(canonicalJson(body));
  return hash.digest('hex');
}
