import { validatePolicyTable } from './policy-validation';

const ok = {
  algorithm: 'tokenBucket',
  limit: 10,
  windowMs: 60_000,
  key: 'user',
  failMode: 'closed',
};

describe('S50 policy validation', () => {
  it('S50 AS-69: a valid table has no offences', () => {
    expect(
      validatePolicyTable({
        'checkout.create': ok,
        'auth.login.account': {
          ...ok,
          algorithm: 'slidingWindow',
          key: 'body.email',
          count: 'failures-only',
          resetOnSuccess: true,
          failureStatuses: [401, 403],
        },
        'search.query.anon': { ...ok, localLeaseFraction: 0.5 },
        'x.y-z.q1': { ...ok, algorithm: 'concurrency' },
      }),
    ).toEqual([]);
  });

  it.each([
    ['Checkout', 'name'],
    ['checkout', 'name'],
    ['checkout.', 'name'],
    ['a.B', 'name'],
    ['a._b', 'name'],
    ['a..b', 'name'],
    ['a b.c', 'name'],
  ])('S50 AS-69: name %p is rejected', (name, text) => {
    const offences = validatePolicyTable({ [name]: ok });
    expect(offences).toHaveLength(1);
    expect(offences[0]).toContain(text);
    expect(offences[0]).toContain(name);
  });

  it.each([
    [{ limit: 0 }, 'limit'],
    [{ limit: -1 }, 'limit'],
    [{ limit: 1.5 }, 'limit'],
    [{ limit: '5' }, 'limit'],
    [{ windowMs: 0 }, 'windowMs'],
    [{ windowMs: 0.5 }, 'windowMs'],
    [{ algorithm: 'leakyBucket' }, 'algorithm'],
    [{ failMode: undefined }, 'failMode'],
    [{ failMode: 'maybe' }, 'failMode'],
    [{ key: 'cookie' }, 'key'],
    [{ localLeaseFraction: 0 }, 'localLeaseFraction'],
    [{ localLeaseFraction: 0.6 }, 'localLeaseFraction'],
    [
      { localLeaseFraction: 0.1, algorithm: 'slidingWindow' },
      'localLeaseFraction',
    ],
    [
      { localLeaseFraction: 0.1, algorithm: 'concurrency' },
      'localLeaseFraction',
    ],
    [{ count: 'failures-only', algorithm: 'concurrency' }, 'failures-only'],
    [{ count: 'always' }, 'count'],
    [{ count: 'failures-only', failureStatuses: [200] }, 'failureStatuses'],
    [{ count: 'failures-only', failureStatuses: [] }, 'failureStatuses'],
  ])('S50 AS-69: %j is rejected naming %p', (patch, text) => {
    const offences = validatePolicyTable({ 'a.b': { ...ok, ...patch } });
    expect(offences.length).toBeGreaterThanOrEqual(1);
    expect(offences.join('\n')).toContain(text);
    expect(offences.every((o) => o.includes('a.b'))).toBe(true);
  });

  it('S50 AS-69: every offence of the whole table is reported at once', () => {
    const offences = validatePolicyTable({
      Bad: { ...ok, limit: 0 },
      'a.b': { ...ok, windowMs: -5, failMode: undefined },
      'c.d': { ...ok, localLeaseFraction: 0.9 },
    });
    expect(offences.length).toBeGreaterThanOrEqual(5);
    expect(offences.join('\n')).toContain('Bad');
    expect(offences.join('\n')).toContain('a.b');
    expect(offences.join('\n')).toContain('c.d');
  });

  it('S50 AS-69: failure-only is allowed on every non-concurrency key source', () => {
    expect(
      validatePolicyTable({
        'a.b': { ...ok, count: 'failures-only', key: 'ip' },
      }),
    ).toEqual([]);
  });
});
