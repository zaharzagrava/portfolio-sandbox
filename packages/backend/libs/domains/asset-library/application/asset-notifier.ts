import { Injectable, Logger } from '@nestjs/common';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { assetMetrics } from './asset-metrics';

/**
 * `assets.changed {lastSeq}` on `shop:<shopId>:assets` after a journaled change (S31 FR-024, AS-33). Best effort: the
 * journal is the truth, so a hub that is down or refuses never fails the request; the failure is counted.
 */
@Injectable()
export class AssetNotifier {
  private readonly logger = new Logger(AssetNotifier.name);

  constructor(private readonly publisher: RealtimePublisher) {}

  async changed(shopId: string, lastSeq: number): Promise<void> {
    try {
      const result = await this.publisher.publish(
        `shop:${shopId}:assets`,
        'assets.changed',
        { lastSeq },
      );
      if (!result.published) assetMetrics.realtimeFailures.add(1);
    } catch (error) {
      assetMetrics.realtimeFailures.add(1);
      this.logger.warn(
        `assets.changed not published: ${(error as Error).message}`,
      );
    }
  }
}
