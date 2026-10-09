import { InvalidCacheOptions } from './cache.errors';

export interface CachePolicy {
  visibility?: 'public' | 'private';
  maxAgeSec?: number;
  sMaxAgeSec?: number;
  staleWhileRevalidateSec?: number;
  staleIfErrorSec?: number;
  noStore?: boolean;
  noCache?: boolean;
  mustRevalidate?: boolean;
  immutable?: boolean;
}

const DURATIONS = [
  ['maxAgeSec', 'max-age'],
  ['sMaxAgeSec', 's-maxage'],
  ['staleWhileRevalidateSec', 'stale-while-revalidate'],
  ['staleIfErrorSec', 'stale-if-error'],
] as const;

/**
 * Builds a `Cache-Control` value from validated parts (P0410) and rejects contradictory policies: `no-store`
 * with any other directive, `s-maxage` on a private response, negative or fractional durations, an empty policy.
 */
export function buildCacheControl(policy: CachePolicy): string {
  const { visibility, noStore, noCache } = policy;
  if (
    visibility !== undefined &&
    visibility !== 'public' &&
    visibility !== 'private'
  )
    throw new InvalidCacheOptions('visibility', 'must be public or private');

  const durations: string[] = [];
  for (const [field, directive] of DURATIONS) {
    const value = policy[field];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0)
      throw new InvalidCacheOptions(field, 'must be a non-negative integer');
    durations.push(`${directive}=${value}`);
  }

  if (
    noStore &&
    (durations.length > 0 ||
      noCache ||
      policy.mustRevalidate ||
      policy.immutable)
  )
    throw new InvalidCacheOptions(
      'noStore',
      'cannot be combined with other cache directives',
    );
  if (visibility === 'private' && policy.sMaxAgeSec !== undefined)
    throw new InvalidCacheOptions(
      'sMaxAgeSec',
      's-maxage applies to shared caches, not to a private response',
    );

  const directives = [
    visibility,
    noStore ? 'no-store' : undefined,
    noCache ? 'no-cache' : undefined,
    ...durations,
    policy.mustRevalidate ? 'must-revalidate' : undefined,
    policy.immutable ? 'immutable' : undefined,
  ].filter((d): d is string => d !== undefined);
  if (directives.length === 0 || (directives.length === 1 && visibility))
    throw new InvalidCacheOptions(
      'policy',
      'must contain at least one cache directive',
    );
  return directives.join(', ');
}
