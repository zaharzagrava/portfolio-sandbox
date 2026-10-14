import { Inject, Injectable, Logger } from '@nestjs/common';
import { chatPurgeNoopCounter } from '../domain/chat-metrics';
import { PORTS, type PurgeRepository } from '../domain/ports';

const BATCH = 500;
const CHANNELS_PER_ROUND = 50;
const DEADLOCK = '40P01';

const pgCode = (error: unknown): string | undefined => {
  const e = error as {
    parent?: { code?: string };
    original?: { code?: string };
  };
  return e?.parent?.code ?? e?.original?.code;
};

/**
 * `tenancy.shop_deleted` removes the shop's channels, members and messages (S24 FR-043). Every statement is bounded
 * (500 rows) and idempotent: a second delivery, or a second consumer racing the first, finds the rows gone. A deadlock
 * between two racing batches is retried. A shop with no channels is a no-op and is counted.
 */
@Injectable()
export class ChatShopPurgeService {
  private readonly log = new Logger(ChatShopPurgeService.name);

  constructor(
    @Inject(PORTS.PurgeRepository) private readonly purge: PurgeRepository,
  ) {}

  async purgeShop(shopId: string): Promise<{ channels: number }> {
    let channels = 0;
    for (;;) {
      const ids = await this.purge.channelIdsOfShop(shopId, CHANNELS_PER_ROUND);
      if (ids.length === 0) break;
      for (const id of ids) {
        await this.drain((n) => this.purge.deleteMessagesBatch(id, n));
        await this.drain((n) => this.purge.deleteMembersBatch(id, n));
        await this.retry(() => this.purge.deleteChannel(id));
        channels += 1;
      }
    }
    if (channels === 0) chatPurgeNoopCounter.add(1);
    else this.log.log({ event: 'chat.purge', channels });
    return { channels };
  }

  private async drain(
    batch: (limit: number) => Promise<number>,
  ): Promise<void> {
    while ((await this.retry(() => batch(BATCH))) > 0) {
      // the next batch, until the channel has nothing left
    }
  }

  private async retry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (pgCode(error) !== DEADLOCK || attempt >= 3) throw error;
      }
    }
  }
}
