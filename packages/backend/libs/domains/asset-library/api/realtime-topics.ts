import { Injectable, OnModuleInit } from '@nestjs/common';
import { AppError } from '@app/common/errors';
import { TopicRegistry } from '@app/infrastructure/realtime';
import { ShopAccessService } from '@app/domains/tenancy';

/**
 * `shop:{shopId}:assets` (S31 AS-33, `assets.changed {lastSeq}`): members whose role holds `products.read`. The decision
 * goes through tenancy's exported R1 service, never its tables; a "no" from tenancy is a refusal, any other failure
 * propagates so the stream answers `503 realtime_policy_unavailable`.
 */
@Injectable()
export class AssetTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
    private readonly access: ShopAccessService,
  ) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'shop',
      suffixes: ['assets'],
      owner: 'asset-library',
      policy: async (viewer, _topic, shopId) => {
        if (!viewer.userId) return false;
        try {
          await this.access.assertMember(
            shopId,
            viewer.userId,
            'products.read',
          );
          return true;
        } catch (error) {
          if (error instanceof AppError && Number(error.status) < 500)
            return false;
          throw error;
        }
      },
    });
  }
}

/** The routes this domain declares in the shared topic type (S51 FR-024). */
declare module '@app/infrastructure/realtime/topics' {
  interface RealtimeTopicPrefixes {
    'shop:assets': `shop:${string}:assets`;
  }
}
