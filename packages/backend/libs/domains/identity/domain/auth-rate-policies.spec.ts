import { identityRatePolicies } from './auth-rate-policies';

const HOUR = 3_600_000;

describe('S01 AS-22: identity rate-limit policies', () => {
  const p = identityRatePolicies.policies;

  it('declares exactly the seven auth.* policies, owned by identity', () => {
    expect(identityRatePolicies.owner).toBe('identity');
    expect(Object.keys(p).sort()).toEqual([
      'auth.login.account',
      'auth.login.ip',
      'auth.refresh.ip',
      'auth.register.ip',
      'auth.reset.account',
      'auth.reset.confirm.ip',
      'auth.reset.ip',
    ]);
  });

  it.each([
    ['auth.register.ip', 10, HOUR, 'ip'],
    ['auth.login.ip', 20, 60_000, 'ip'],
    ['auth.login.account', 5, 15 * 60_000, 'body.email'],
    ['auth.refresh.ip', 60, 60_000, 'ip'],
    ['auth.reset.ip', 5, HOUR, 'ip'],
    ['auth.reset.confirm.ip', 10, HOUR, 'ip'],
    ['auth.reset.account', 3, HOUR, 'body.email'],
  ] as const)(
    '%s has limit %d per %d ms keyed by %s',
    (name, limit, windowMs, key) => {
      const policy = p[name];
      expect(policy).toMatchObject({
        algorithm: 'slidingWindow',
        limit,
        windowMs,
        key,
        failMode: 'closed',
      });
    },
  );

  it.each(['auth.login.account', 'auth.reset.account'] as const)(
    '%s counts failures only and resets on success',
    (name) => {
      expect(p[name]).toMatchObject({
        count: 'failures-only',
        resetOnSuccess: true,
      });
    },
  );

  it('the IP policies count every request', () => {
    for (const name of [
      'auth.register.ip',
      'auth.login.ip',
      'auth.refresh.ip',
      'auth.reset.ip',
      'auth.reset.confirm.ip',
    ] as const)
      expect('count' in p[name]).toBe(false);
  });

  it('every policy fails closed', () => {
    for (const policy of Object.values(p))
      expect(policy.failMode).toBe('closed');
  });
});
