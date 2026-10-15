import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ConsumerLag } from '@app/infrastructure/projections/consumer-lag';
import {
  LEDGER_TOPIC,
  ORDER_PAID_TOPIC,
  PAYOUTS_TOPIC,
} from '../application/events/consumed-events';
import { CONSUMERS } from '../application/fact-ingestion.service';
import type { FactStream, StreamLag } from '../domain/ports';

const TOPICS: Record<FactStream, string> = {
  orders: ORDER_PAID_TOPIC,
  payouts: PAYOUTS_TOPIC,
  ledger: LEDGER_TOPIC,
};

const CACHE_MS = 3_000;

/**
 * Consumer lag of each fact stream from the broker (S53 `ConsumerLag`). A group that does not exist yet or a broker
 * that cannot be reached means "not caught up": the watermark then stays at what was applied. The answer is cached for
 * a few seconds because live statements read the watermark on every request.
 */
@Injectable()
export class KafkaStreamLag implements StreamLag {
  private readonly cache = new Map<FactStream, { at: number; value: boolean }>();

  constructor(
    private readonly lag: ConsumerLag,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async isCaughtUp(stream: FactStream): Promise<boolean> {
    const hit = this.cache.get(stream);
    const now = this.clock.nowMs();
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    let value = false;
    try {
      value = (
        await this.lag.read(CONSUMERS[stream], { topics: [TOPICS[stream]] })
      ).caughtUp;
    } catch {
      value = false;
    }
    this.cache.set(stream, { at: now, value });
    return value;
  }
}
