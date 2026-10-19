import 'reflect-metadata';
import { RATE_LIMIT_METADATA } from '@app/infrastructure/rate-limit/rate-limit.metadata';
import type { RateLimitRouteOptions } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { SyncController } from './api/sync.controller';
import { catalogSyncRatePolicies } from './rate-limit-policies';

const policiesOf = (controller: { prototype: object }, handler: string) =>
  (
    Reflect.getMetadata(
      RATE_LIMIT_METADATA,
      (controller.prototype as Record<string, object>)[handler],
    ) as RateLimitRouteOptions[] | undefined
  )?.map((o) => o.policy);

/**
 * J04 G-25: the routes the journey hammers each have their own policy, so one noisy surface cannot spend another's budget
 * (the journey address itself is lifted by the local profile's allow-list, never by a policy of these names).
 */
describe('J04 G-25: rate-limit policy of every route of the catalog-sync chain', () => {
  it('J04 G-25: till push and pull use the per-device policies', () => {
    expect(policiesOf(SyncController, 'pushOperations')).toEqual([
      'catalog-sync.sync-push.device',
    ]);
    expect(policiesOf(SyncController, 'pullChanges')).toEqual([
      'catalog-sync.sync-pull.device',
    ]);
  });

  it('J04 G-25: the import start and the sync policies are declared by the capability', () => {
    for (const name of [
      'catalog-sync.import-start.shop',
      'catalog-sync.sync-push.device',
      'catalog-sync.sync-pull.device',
      'catalog-sync.sync-now.integration',
    ])
      expect(Object.keys(catalogSyncRatePolicies.policies)).toContain(name);
  });
});
