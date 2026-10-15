import { developerPlatformRatePolicies } from './rate-limit-policies';

describe('developer-platform rate-limit policies (S50 registry)', () => {
  const policies = developerPlatformRatePolicies.policies;

  it.each<[keyof typeof policies, number, string]>([
    ['webhooks.manage.shop', 120, 'shop'],
    ['webhooks.replay.shop', 30, 'shop'],
    ['webhooks.ping.endpoint', 10, 'custom'],
  ])(
    'S43 AS-15: %s allows %i calls a minute per %s and fails closed when the limiter store is down',
    (name, limit, key) => {
      expect(policies[name]).toMatchObject({
        limit,
        windowMs: 60_000,
        key,
        failMode: 'closed',
      });
    },
  );
});
