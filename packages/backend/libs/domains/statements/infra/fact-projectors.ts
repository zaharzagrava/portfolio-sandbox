import { Injectable } from '@nestjs/common';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import {
  consumedJournalPosted,
  consumedOrderPaid,
  consumedPayoutPaid,
  LEDGER_TOPIC,
  LEGACY_JOURNAL_MARK,
  ORDER_PAID_TOPIC,
  PAYOUTS_TOPIC,
} from '../application/events/consumed-events';
import {
  CONSUMERS,
  FactIngestionService,
} from '../application/fact-ingestion.service';

/**
 * The three consumers of the statements' fact store (S16 FR-033, contracts/events.md "Consumed"). Each is a thin
 * adapter: the framework hands over validated envelopes, `FactIngestionService.ingest` records the event in the
 * inbox, applies it under the aggregate's version guard and moves the stream's watermark, all in one transaction.
 * The idempotency mechanism is declared `versionGuard` because the inbox is used inside the ingestion transaction
 * (so the duplicate is counted in the statements' own metric).
 */
@Injectable()
abstract class FactProjector implements Projector {
  abstract readonly name: string;
  abstract readonly topics: string[];
  abstract readonly handles: HandledEvent[];
  readonly idempotency: IdempotencyMechanism = 'versionGuard';
  protected abstract readonly stream: 'orders' | 'payouts' | 'ledger';

  constructor(protected readonly ingestion: FactIngestionService) {}

  project(events: EventEnvelope[]): Promise<SinkCounts> {
    return this.ingestion.ingest(this.stream, events);
  }
}

@Injectable()
export class SalesFactProjector extends FactProjector {
  readonly name = CONSUMERS.orders;
  readonly topics = [ORDER_PAID_TOPIC];
  readonly handles: HandledEvent[] = [{ event: consumedOrderPaid }];
  protected readonly stream = 'orders' as const;
}

@Injectable()
export class PayoutFactProjector extends FactProjector {
  readonly name = CONSUMERS.payouts;
  readonly topics = [PAYOUTS_TOPIC];
  readonly handles: HandledEvent[] = [{ event: consumedPayoutPaid }];
  protected readonly stream = 'payouts' as const;
}

@Injectable()
export class LedgerFactProjector extends FactProjector {
  readonly name = CONSUMERS.ledger;
  readonly topics = [LEDGER_TOPIC];
  /** v1 (deltas, no balances) is not lifted to v2: it arrives marked and is skipped and counted. */
  readonly handles: HandledEvent[] = [
    {
      event: consumedJournalPosted,
      upgradeFrom: [{ version: 1, upcast: () => ({ ...LEGACY_JOURNAL_MARK }) }],
    },
  ];
  protected readonly stream = 'ledger' as const;
}

export const statementsProjectors = [
  SalesFactProjector,
  PayoutFactProjector,
  LedgerFactProjector,
];
