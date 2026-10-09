import { InvalidLoaderResult } from './cache.errors';

/** What is stored under a cache key (data-model: Cache entry). */
export interface Envelope<T> {
  /** null = negative entry ("we checked, it does not exist"). */
  v: T | null;
  /** Soft expiry, absolute ms on the injected clock. */
  exp: number;
  /** Hard expiry; the store lifetime is `hard - now`. */
  hard: number;
  /** How long the loader took, ms; feeds XFetch. */
  delta: number;
  /** Optional integer version for `invalidateIfOlder`. */
  ver?: number;
}

export type EncodeResult =
  | { kind: 'ok'; payload: string; bytes: number }
  | { kind: 'oversize'; bytes: number };

export type ParseResult<T> =
  | { kind: 'miss' }
  | { kind: 'corrupt' }
  | { kind: 'ok'; envelope: Envelope<T> };

/** Throws `InvalidLoaderResult` unless the value survives a JSON round trip's first half. */
export function assertJsonValue(value: unknown): void {
  if (value === undefined)
    throw new InvalidLoaderResult(
      'the loader resolved undefined (use null for "not found")',
    );
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new InvalidLoaderResult(
      `the value cannot be written as JSON (${(error as Error).message})`,
    );
  }
  if (json === undefined)
    throw new InvalidLoaderResult('the value cannot be written as JSON');
}

export function encodeEnvelope<T>(
  envelope: Envelope<T>,
  maxEntryBytes: number,
): EncodeResult {
  assertJsonValue(envelope.v);
  const payload = JSON.stringify(envelope);
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > maxEntryBytes) return { kind: 'oversize', bytes };
  return { kind: 'ok', payload, bytes };
}

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

export function parseEnvelope<T>(
  raw: string | null | undefined,
): ParseResult<T> {
  if (raw === null || raw === undefined) return { kind: 'miss' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { kind: 'corrupt' };
  const o = parsed as Record<string, unknown>;
  if (
    !('v' in o) ||
    !isFiniteNumber(o.exp) ||
    !isFiniteNumber(o.hard) ||
    !isFiniteNumber(o.delta) ||
    o.hard < o.exp
  )
    return { kind: 'corrupt' };
  if (o.ver !== undefined && !Number.isSafeInteger(o.ver))
    return { kind: 'corrupt' };
  return {
    kind: 'ok',
    envelope: {
      v: o.v as T | null,
      exp: o.exp,
      hard: o.hard,
      delta: o.delta,
      ...(o.ver !== undefined ? { ver: o.ver as number } : {}),
    },
  };
}
