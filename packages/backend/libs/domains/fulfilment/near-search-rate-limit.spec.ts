import 'reflect-metadata';
import { RATE_LIMIT_METADATA } from '@app/infrastructure/rate-limit/rate-limit.metadata';
import type { RateLimitRouteOptions } from '@app/infrastructure/rate-limit/rate-limit.decorator';
import { PickupPublicController } from './api/pickup-public.controller';

const policiesOf = (handler: string) =>
  (
    Reflect.getMetadata(
      RATE_LIMIT_METADATA,
      (PickupPublicController.prototype as unknown as Record<string, object>)[
        handler
      ],
    ) as RateLimitRouteOptions[] | undefined
  )?.map((o) => o.policy);

describe('J04 G-25: rate-limit policy of the pickup near-search routes', () => {
  it('J04 G-25: near-me search and the exact browse share the near-search policy', () => {
    expect(policiesOf('searchNear')).toEqual(['fulfilment.near-search']);
    expect(policiesOf('browse')).toEqual(['fulfilment.near-search']);
  });
});
