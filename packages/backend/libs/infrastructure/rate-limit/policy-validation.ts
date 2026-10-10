const NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ALGORITHMS = ['tokenBucket', 'slidingWindow', 'concurrency'];
const KEYS = [
  'ip',
  'user',
  'userOrIp',
  'apiKey',
  'shop',
  'body.email',
  'custom',
];
const isPositiveInt = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;

/** Every offence of the whole table, one string each, naming the policy (AS-69). Pure. */
export function validatePolicyTable(table: Record<string, unknown>): string[] {
  const offences: string[] = [];
  for (const [name, raw] of Object.entries(table)) {
    const bad = (message: string) =>
      offences.push(`policy "${name}": ${message}`);
    if (!NAME.test(name))
      bad(
        'name must be <area>.<name>[.<qualifier>...] in lowercase letters, digits and hyphens',
      );
    const p = (raw ?? {}) as Record<string, unknown>;
    if (!ALGORITHMS.includes(p.algorithm as string))
      bad(`unknown algorithm ${String(p.algorithm)}`);
    if (!isPositiveInt(p.limit)) bad('limit must be a positive integer');
    if (!isPositiveInt(p.windowMs)) bad('windowMs must be a positive integer');
    if (!KEYS.includes(p.key as string))
      bad(`key must be one of ${KEYS.join(', ')}`);
    if (p.failMode !== 'open' && p.failMode !== 'closed')
      bad('failMode is required and must be "open" or "closed"');
    if (p.localLeaseFraction !== undefined) {
      const f = p.localLeaseFraction;
      if (p.algorithm !== 'tokenBucket')
        bad('localLeaseFraction is only for token bucket policies');
      if (typeof f !== 'number' || !(f > 0 && f <= 0.5))
        bad('localLeaseFraction must be in (0, 0.5]');
    }
    if (p.count !== undefined) {
      if (p.count !== 'failures-only')
        bad(`count must be "failures-only", got ${JSON.stringify(p.count)}`);
      else if (p.algorithm === 'concurrency')
        bad('count "failures-only" cannot be set on a concurrency policy');
    }
    if (p.failureStatuses !== undefined) {
      const s = p.failureStatuses;
      if (
        p.count !== 'failures-only' ||
        !Array.isArray(s) ||
        s.length === 0 ||
        !s.every((x) => Number.isInteger(x) && x >= 400 && x <= 599)
      )
        bad(
          'failureStatuses must be a non-empty list of 4xx/5xx statuses and needs count "failures-only"',
        );
    }
  }
  return offences;
}
