import { Global, Module } from '@nestjs/common';
import { ApiConfigModule, ApiConfigService } from '@app/common/config';
import { CloudFrontDeliveryEdge } from './cloudfront-delivery-edge';
import {
  DeliveryEdge,
  DeliveryEdgeNotConfiguredError,
} from './delivery-edge.port';
import { UnconfiguredDeliveryEdge } from './unconfigured-delivery-edge';

/** Optional override: sends invalidations to the CDN. Without it `invalidate` fails with the typed error. */
export const DELIVERY_EDGE_INVALIDATOR = Symbol('DELIVERY_EDGE_INVALIDATOR');

@Global()
@Module({
  imports: [ApiConfigModule],
  providers: [
    {
      provide: DeliveryEdge,
      inject: [
        ApiConfigService,
        { token: DELIVERY_EDGE_INVALIDATOR, optional: true },
      ],
      useFactory: (
        config: ApiConfigService,
        invalidate?: (paths: string[]) => Promise<void>,
      ): DeliveryEdge => {
        const keyPairId = config.get('cloudfront_key_pair_id');
        const privateKey = config.get('cloudfront_private_key');
        if (!keyPairId || !privateKey) return new UnconfiguredDeliveryEdge();
        return new CloudFrontDeliveryEdge({
          keyPairId,
          privateKey,
          invalidate:
            invalidate ??
            (() =>
              Promise.reject(
                new DeliveryEdgeNotConfiguredError('invalidation path'),
              )),
        });
      },
    },
  ],
  exports: [DeliveryEdge],
})
export class DeliveryEdgeModule {}
