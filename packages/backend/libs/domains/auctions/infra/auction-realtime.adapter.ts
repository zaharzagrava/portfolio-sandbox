import { Injectable, Logger } from '@nestjs/common';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import type { AuctionRealtimePort } from '../domain/auction-ports';
import { realtimeFailedCounter } from '../domain/auction-metrics';

/**
 * Pushes `price` and `closed` to the public topic `auction:<id>` after the commit (S51, FR-035). Best effort: a failure
 * is logged and counted, never thrown, and never changes a bid or a close. Messages carry a `version` so a client
 * ignores anything not above the one it holds; the winner's identity is never in a message.
 */
@Injectable()
export class AuctionRealtimeAdapter implements AuctionRealtimePort {
  private readonly logger = new Logger(AuctionRealtimeAdapter.name);

  constructor(private readonly publisher: RealtimePublisher) {}

  publishPrice(
    message: Parameters<AuctionRealtimePort['publishPrice']>[0],
  ): Promise<void> {
    return this.publish(message.auctionId, 'price', message);
  }

  publishClosed(
    message: Parameters<AuctionRealtimePort['publishClosed']>[0],
  ): Promise<void> {
    return this.publish(message.auctionId, 'closed', message);
  }

  private async publish(
    auctionId: string,
    event: 'price' | 'closed',
    payload: object,
  ): Promise<void> {
    try {
      await this.publisher.publish(
        `auction:${auctionId}`,
        event,
        payload as Record<string, unknown>,
      );
    } catch (error) {
      realtimeFailedCounter.add();
      this.logger.warn(
        `realtime ${event} failed for auction ${auctionId}: ${(error as Error).name}`,
      );
    }
  }
}
