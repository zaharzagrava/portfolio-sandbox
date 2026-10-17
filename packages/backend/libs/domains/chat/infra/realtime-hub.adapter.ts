import { Injectable, Logger } from '@nestjs/common';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import type { HubEventType, RealtimeHub } from '../domain/ports';

/**
 * Receipts and presence go through the S51 hub as live-only events (`replay: false`) on `chat:<channelId>`; the
 * topic's policy lets active members of the channel subscribe (see `ChatTopics`). The hub reports a store fault as
 * `published: false` and never throws for it; a refused event (bad shape) is a bug and is reported the same way.
 */
@Injectable()
export class RealtimeHubAdapter implements RealtimeHub {
  private readonly log = new Logger(RealtimeHubAdapter.name);

  constructor(private readonly publisher: RealtimePublisher) {}

  async publish(
    channelId: string,
    type: HubEventType,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const result = await this.publisher.publish(
        `chat:${channelId}`,
        type,
        data,
        { replay: false },
      );
      return result.published;
    } catch (error) {
      this.log.warn(
        `hub publish failed type=${type} channelId=${channelId} reason=${(error as Error).message}`,
      );
      return false;
    }
  }
}
