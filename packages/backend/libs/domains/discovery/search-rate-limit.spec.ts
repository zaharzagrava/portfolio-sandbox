import 'reflect-metadata';
import { RATE_LIMIT_METADATA } from '@app/infrastructure/rate-limit/rate-limit.metadata';
import type { RateLimitRouteOptions } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { SearchController } from './api/search.controller';

describe('J04 G-25: rate-limit policy of product search', () => {
  it('J04 G-25: product search has its own policy', () => {
    const handler = (
      SearchController.prototype as unknown as Record<string, object>
    ).products;
    const policies = (
      Reflect.getMetadata(RATE_LIMIT_METADATA, handler) as
        RateLimitRouteOptions[] | undefined
    )?.map((o) => o.policy);
    expect(policies).toEqual(['discovery.search.query']);
  });
});
