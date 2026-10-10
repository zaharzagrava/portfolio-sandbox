/**
 * How long a shaped upstream body may live in the BFF's shared cache (S48 FR-011, AS-19). Pure.
 * Eligible only when the upstream marked the answer shared-cacheable (`s-maxage`, or `public` with `max-age`) and did
 * not say `private`, `no-store` or `no-cache`; never longer than `ceilingMs`; ambiguous headers are not cached.
 * Returns 0 for "do not store".
 */
export function sharedCacheTtlMs(
  cacheControl: string | undefined,
  ceilingMs: number,
): number {
  if (!cacheControl) return 0;
  const directives = new Map<string, string[]>();
  for (const part of cacheControl.split(',')) {
    const [name, ...rest] = part.trim().toLowerCase().split('=');
    if (!name) continue;
    directives.set(name, [...(directives.get(name) ?? []), rest.join('=')]);
  }
  if (
    directives.has('private') ||
    directives.has('no-store') ||
    directives.has('no-cache')
  )
    return 0;

  const seconds = (name: string): number | undefined | 'bad' => {
    const values = directives.get(name);
    if (!values) return undefined;
    if (values.length > 1 || !/^\d+$/.test(values[0])) return 'bad';
    return Number(values[0]);
  };
  const sMaxAge = seconds('s-maxage');
  if (sMaxAge === 'bad') return 0;
  let ttl: number;
  if (sMaxAge !== undefined) ttl = sMaxAge * 1_000;
  else if (directives.has('public')) {
    const maxAge = seconds('max-age');
    if (maxAge === undefined || maxAge === 'bad') return 0;
    ttl = maxAge * 1_000;
  } else return 0;
  return Math.max(0, Math.min(ttl, ceilingMs));
}
