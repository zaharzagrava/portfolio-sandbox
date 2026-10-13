import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  PermanentError,
  TransientError,
} from '@app/infrastructure/projections/errors';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { z } from 'zod';
import { JournalPosted } from '../application/events/ledger-events';
import {
  consumerDeadLetteredCounter,
  projectionLagGauge,
  projectionLegacySkippedCounter,
  projectionStaleCounter,
} from '../domain/ledger-metrics';
import {
  BALANCE_DURABLE_STORE,
  BALANCE_HOT_STORE,
  PROJECTION_PROGRESS,
  type BalanceReadModelStore,
  type ProjectionProgress,
} from '../domain/ledger-ports';

/** A v1 payload (deltas, no balances) lifted to v2 with no lines: the projector counts it and skips it. */
const v1ToV2 = (payload: unknown) => ({
  journalId: '00000000-0000-0000-0000-000000000000',
  kind: (payload as { kind?: string })?.kind,
  currency: 'EUR',
  postedAt: new Date(0).toISOString(),
  lines: [],
});

/**
 * `ledger.journal_posted` v2 -> the balance read model (S14 FR-025, research R-8). Every line carries the absolute
 * balance and its version, so the version guard of both stores makes replays, duplicates and reordering harmless;
 * shards project independently. The durable copy is written first, then the hot one; a store that is down makes the
 * partition pause and retry (`TransientError`) so the two never drift apart for long. v1 messages (deltas) are
 * skipped and counted; an invalid payload is a permanent failure for the dead-letter topic.
 */
@Injectable()
export class BalanceProjector implements Projector {
  readonly name = 'ledger-balances';
  readonly topics = [JournalPosted.topic];
  readonly idempotency: IdempotencyMechanism = 'versionGuard';
  readonly handles: HandledEvent[] = [
    { event: JournalPosted, upgradeFrom: [{ version: 1, upcast: v1ToV2 }] },
  ];
  readonly aggregateIdSchema = z.string().uuid();
  private readonly logger = new Logger(BalanceProjector.name);

  constructor(
    @Inject(BALANCE_HOT_STORE) private readonly hot: BalanceReadModelStore,
    @Inject(BALANCE_DURABLE_STORE)
    private readonly durable: BalanceReadModelStore,
    @Inject(PROJECTION_PROGRESS) private readonly progress: ProjectionProgress,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<void | SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const raw of events) {
      if (raw.type !== 'ledger.journal_posted') continue;
      const event = this.parse(raw);
      if (event.payload.lines.length === 0) {
        projectionLegacySkippedCounter.add();
        continue;
      }
      const projectedAt = this.clock.now();
      for (const l of event.payload.lines) {
        const line = {
          accountId: l.accountId,
          shard: l.shard,
          currency: event.payload.currency,
          balanceMinor: l.balanceAfterMinor,
          version: l.balanceVersion,
          projectedAt,
        };
        let outcome: 'applied' | 'stale' | 'duplicate';
        try {
          outcome = await this.durable.putIfNewer(line);
          // the hot copy follows even when the durable one already had this version: it may have missed it
          const hotOutcome = await this.hot.putIfNewer(line);
          if (outcome === 'applied' || hotOutcome === 'applied')
            outcome = 'applied';
        } catch (error) {
          throw new TransientError(
            `balance read model unavailable (${(error as Error).name})`,
            { cause: error },
          );
        }
        if (outcome === 'stale') {
          projectionStaleCounter.add();
          counts.stale++;
        } else if (outcome === 'duplicate') counts.duplicate++;
        else counts.applied++;
      }
      projectionLagGauge.set(
        Math.max(
          0,
          (projectedAt.getTime() - Date.parse(event.payload.postedAt)) / 1000,
        ),
      );
      // How far the projection has got, for the checker's lag gauge in another process; not worth stopping for.
      await this.progress
        .record(new Date(event.payload.postedAt))
        .catch(() => undefined);
    }
    return counts;
  }

  private parse(raw: EventEnvelope) {
    try {
      const matched = JournalPosted.match(raw);
      if (matched) return matched;
    } catch {
      /* falls through to the refusal below */
    }
    consumerDeadLetteredCounter.add(1, { reason: 'invalid_payload' });
    this.logger.warn(
      `journal_posted of aggregate ${raw.aggregateId} refused: invalid payload`,
    );
    throw new PermanentError(`invalid_payload: ${raw.type}`);
  }
}
