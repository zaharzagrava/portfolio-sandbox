import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  journalPostedV2Schema,
  payoutPaidSchema,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { TransactionRunner } from '@app/infrastructure/context';
import { InboxService } from '@app/infrastructure/inbox/inbox.service';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { SinkCounts } from '@app/infrastructure/projections/projector';
import { eventsAppliedCounter, eventsRejectedCounter } from '../domain/metrics';
import { parseOrderPaid } from '../domain/order-paid-fact';
import { monthOf } from '../domain/period';
import {
  FACT_REPOSITORY,
  PERIOD_REPOSITORY,
  type ApplyOutcome,
  type FactRepository,
  type FactStream,
  type PeriodRepository,
} from '../domain/ports';
import './statements.job-types';

const SHOP_ACCOUNT = /^SHOP_([0-9a-f-]{36})$/i;
export const PLATFORM_FEES_ACCOUNT = 'PLATFORM_FEES';

/** Consumer group and inbox name of each stream. */
export const CONSUMERS: Record<FactStream, string> = {
  orders: 'statements-sales',
  payouts: 'statements-payouts',
  ledger: 'statements-ledger',
};

/**
 * Applies validated facts to the statements' own store (S16 FR-033..FR-037): idempotent per event (the framework's
 * inbox) and version-guarded per aggregate, a rejected payload is a `PermanentError` with a reason and no effect, and
 * a fact that lands in a month already `CLOSING` or `CLOSED` queues the adjustment work for it (FR-031).
 */
@Injectable()
export class FactIngestionService {
  private readonly logger = new Logger(FactIngestionService.name);

  constructor(
    @Inject(FACT_REPOSITORY) private readonly facts: FactRepository,
    @Inject(PERIOD_REPOSITORY) private readonly periods: PeriodRepository,
    private readonly jobs: JobsService,
    private readonly inbox: InboxService,
    private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private reject(
    stream: FactStream,
    reason: string,
    envelope: EventEnvelope,
  ): never {
    eventsRejectedCounter.add(1, { stream, reason });
    this.logger.warn(
      `${envelope.type} ${envelope.eventId} refused (${reason}) on the ${stream} stream`,
    );
    throw new PermanentError(reason);
  }

  private count(stream: FactStream, outcome: string): void {
    eventsAppliedCounter.add(1, { stream, outcome });
  }

  /**
   * One batch in one transaction: `(consumer, eventId)` is recorded with the effect (a redelivery or a topic replay of
   * an applied event is a `duplicate`), then the event is applied and version-guarded. A refused event throws a
   * `PermanentError` and rolls the batch back; the consumer framework then retries the events one by one, so a poison
   * message never blocks the valid ones (AS-54).
   */
  ingest(stream: FactStream, envelopes: EventEnvelope[]): Promise<SinkCounts> {
    return this.runner.run(async () => {
      const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
      for (const envelope of envelopes) {
        if (
          !(await this.inbox.recordOnce(CONSUMERS[stream], envelope.eventId))
        ) {
          counts.duplicate++;
          this.count(stream, 'duplicate');
          continue;
        }
        const outcome =
          stream === 'orders'
            ? await this.applyOrderPaid(envelope)
            : stream === 'payouts'
              ? await this.applyPayoutPaid(envelope)
              : await this.applyJournalPosted(envelope);
        if (outcome === 'applied') counts.applied++;
        else if (outcome === 'duplicate') counts.duplicate++;
        else counts.stale++;
      }
      return counts;
    });
  }

  async applyOrderPaid(envelope: EventEnvelope): Promise<ApplyOutcome> {
    const parsed = parseOrderPaid(envelope.payload);
    if (!parsed.ok) this.reject('orders', parsed.reason, envelope);
    const { fact } = parsed as Extract<typeof parsed, { ok: true }>;
    const now = this.clock.now();
    const occurredAt = new Date(envelope.occurredAt);
    const outcome = await this.facts.applySaleFacts(
      fact.orderId,
      fact.orderVersion,
      fact.lines.map((line) => ({
        orderId: fact.orderId,
        orderVersion: fact.orderVersion,
        ...line,
        paidAt: fact.paidAt,
        recordedAt: occurredAt,
        appliedAt: now,
        eventId: envelope.eventId,
      })),
    );
    await this.facts.advanceWatermark('orders', occurredAt, now);
    this.count('orders', outcome);
    if (outcome === 'applied') {
      const month = monthOf(fact.paidAt);
      for (const shopId of new Set(fact.lines.map((l) => l.shopId)))
        await this.queueLate(month, `late_sale:${fact.orderId}`, shopId);
    }
    return outcome;
  }

  async applyPayoutPaid(envelope: EventEnvelope): Promise<ApplyOutcome> {
    const parsed = payoutPaidSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      const currency = (envelope.payload as { currency?: unknown })?.currency;
      this.reject(
        'payouts',
        typeof currency === 'string' && currency !== 'EUR'
          ? 'currency_not_eur'
          : 'invalid_payload',
        envelope,
      );
    }
    const payload = (
      parsed as { data: ReturnType<typeof payoutPaidSchema.parse> }
    ).data;
    if (payload.currency !== 'EUR')
      this.reject('payouts', 'currency_not_eur', envelope);
    const now = this.clock.now();
    const occurredAt = new Date(envelope.occurredAt);
    const paidAt = new Date(payload.paidAt);
    const outcome = await this.facts.applyPayoutFact({
      payoutId: payload.payoutId,
      shopId: payload.shopId,
      amountMinor: payload.amountMinor,
      paidAt,
      payoutVersion: payload.payoutVersion,
      recordedAt: occurredAt,
      appliedAt: now,
      eventId: envelope.eventId,
    });
    await this.facts.advanceWatermark('payouts', occurredAt, now);
    this.count('payouts', outcome);
    if (outcome === 'applied')
      await this.queueLate(
        monthOf(paidAt),
        `late_payout:${payload.payoutId}`,
        payload.shopId,
      );
    return outcome;
  }

  /** `ledger.journal_posted` v2: only kind `SALE` is stored, its credit lines only, and never a shard. */
  async applyJournalPosted(
    envelope: EventEnvelope,
  ): Promise<ApplyOutcome | 'ignored' | 'legacy'> {
    const payload = envelope.payload as Record<string, unknown>;
    if (payload?.__legacyV1 === true) {
      this.count('ledger', 'legacy');
      return 'legacy';
    }
    const parsed = journalPostedV2Schema.safeParse(payload);
    if (!parsed.success) this.reject('ledger', 'invalid_payload', envelope);
    const journal = (
      parsed as { data: ReturnType<typeof journalPostedV2Schema.parse> }
    ).data;
    const now = this.clock.now();
    const occurredAt = new Date(envelope.occurredAt);
    await this.facts.advanceWatermark('ledger', occurredAt, now);
    if (journal.kind !== 'SALE') {
      this.count('ledger', 'ignored');
      return 'ignored';
    }
    const credits = journal.lines
      .filter(
        (line) =>
          line.amountMinor > 0 &&
          (line.accountId === PLATFORM_FEES_ACCOUNT ||
            SHOP_ACCOUNT.test(line.accountId)),
      )
      .map((line) => ({
        accountId: line.accountId,
        amountMinor: line.amountMinor,
      }));
    const outcome = await this.facts.applyLedgerFact({
      journalId: journal.journalId,
      orderId: journal.orderId ?? null,
      postedAt: new Date(journal.postedAt),
      recordedAt: occurredAt,
      appliedAt: now,
      eventId: envelope.eventId,
      credits,
    });
    this.count('ledger', outcome);
    return outcome;
  }

  /** A fact that belongs to a month that is already `CLOSING` or `CLOSED` queues its adjustment (inside this transaction). */
  private async queueLate(
    month: string,
    cause: string,
    shopId: string,
  ): Promise<void> {
    if ((await this.periods.statusOf(month)) === 'OPEN') return;
    await this.jobs.enqueue(
      'statements.reconcile-month',
      { month, cause, shopId },
      { idempotencyKey: `${cause}:${month}:${shopId}`, shopId },
    );
  }
}
