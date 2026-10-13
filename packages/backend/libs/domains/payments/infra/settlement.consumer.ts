import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { z } from 'zod';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import {
  PermanentError,
  TransientError,
} from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { orderEvents } from '../application/events/order-events';
import {
  SettlementService,
  type OrderPaidPayload,
} from '../application/settlement.service';
import { consumerDeadLetteredCounter } from '../domain/ledger-metrics';

/**
 * `order.paid` on `orders.events` -> settlement (S14 FR-015, FR-016, contracts/events.md). Own group
 * `ledger-settlement`. Idempotency is natural: the `SETTLEMENT` journal id is deterministic from the order, so a
 * duplicate, concurrent or late delivery changes nothing. A payload that cannot be settled is a permanent failure
 * for the dead-letter topic, counted by reason; a sale that is not recorded yet is deferred as a durable job (the
 * partition is never stalled for minutes). `payments` never imports `orders`: the contract comes from
 * `packages/contracts`.
 */
@Injectable()
export class SettlementConsumer implements Projector, OnApplicationBootstrap {
  readonly name = 'ledger-settlement';
  readonly topics = [orderEvents().paid.topic];
  readonly idempotency: IdempotencyMechanism = 'natural';
  readonly handles: HandledEvent[] = [{ event: orderEvents().paid }];
  readonly aggregateIdSchema = z.string().uuid();
  private readonly logger = new Logger(SettlementConsumer.name);
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly settlement: SettlementService,
    @Optional() private readonly shutdown?: ShutdownRegistry,
  ) {}

  onApplicationBootstrap(): void {
    this.shutdown?.register({
      name: 'ledger.settlement-consumer',
      order: 10, // stop intake first
      timeoutMs: 9_000,
      run: () => this.drain(),
    });
  }

  /** On the stop signal the message in hand is finished; a batch that arrives later is left for the next consumer. */
  async drain(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.inFlight]);
  }

  async project(events: EventEnvelope[]): Promise<void> {
    if (this.stopping)
      throw new TransientError('the settlement consumer is stopping');
    const running = this.apply(events);
    this.inFlight.add(running);
    try {
      await running;
    } finally {
      this.inFlight.delete(running);
    }
  }

  private async apply(events: EventEnvelope[]): Promise<void> {
    for (const raw of events) {
      if (raw.type !== 'order.paid') continue;
      const paid = this.parse(raw);
      const outcome = await this.settlement.settle(paid);
      switch (outcome) {
        case 'invalid_payload':
        case 'currency_mismatch':
          throw this.refuse(raw, outcome);
        case 'sale_missing':
          if (!(await this.settlement.defer(paid, 1)))
            throw this.refuse(raw, 'sale_not_found');
          break;
        default:
          break; // settled, duplicate or skipped: acknowledged
      }
    }
  }

  private parse(raw: EventEnvelope): OrderPaidPayload {
    let matched;
    try {
      matched = orderEvents().paid.match(raw);
    } catch {
      throw this.refuse(raw, 'invalid_payload');
    }
    if (!matched) throw this.refuse(raw, 'invalid_payload'); // a contract version this consumer does not know
    return matched.payload;
  }

  private refuse(raw: EventEnvelope, reason: string): PermanentError {
    consumerDeadLetteredCounter.add(1, { reason });
    this.logger.warn(
      `order.paid dead-lettered (${reason}) aggregate ${raw.aggregateId}`,
    );
    return new PermanentError(`${reason}: ${raw.type}`);
  }
}
