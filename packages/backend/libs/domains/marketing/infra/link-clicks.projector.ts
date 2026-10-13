import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { Projector } from '@app/infrastructure/projections/projector';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { isValidCode } from '../application/code-format';
import { LinkClicked } from '../domain/link-events';
import {
  linkClickConsumerLagGauge,
  linkClickDeadLetteredCounter,
  linkClickProjectedCounter,
} from '../domain/link-metrics';

/** A click stamped further ahead than this cannot be real (FR-067). */
const MAX_FUTURE_MS = 5 * 60_000;
const REMEMBERED_REJECTIONS = 10_000;

/**
 * `links.events` -> ClickHouse `link_clicks` (S37 G17, `contracts/events.md`). The framework validates every payload
 * against `linkClickedEventSchema` and dead-letters the invalid ones with their reason (`dlq_total{consumer}`); this
 * consumer adds the checks a schema cannot make (code format, `ts` not in the future) and counts what it rejects in
 * `link_click_dead_lettered_total`. A click is counted once whatever the delivery count: the table keeps one row per
 * click id at merge time and statistics count `uniqExact(click_id)` at read time, so idempotency is `natural`.
 */
@Injectable()
export class LinkClicksProjector implements Projector {
  readonly name = 'link-clicks';
  readonly topics = [LinkClicked.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: LinkClicked }];
  /** The batch fails once for its poison event, then every event is tried alone: a second attempt, then the DLQ. */
  readonly attempts = 2;
  /** The framework retries a rejected event once; it must still be counted once. */
  private readonly rejected = new Set<string>();

  private readonly sink: ClickHouseSink;

  constructor(
    clickhouse: ClickHouseService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.sink = new ClickHouseSink(clickhouse);
  }

  async project(events: EventEnvelope[]): Promise<void> {
    const now = this.clock.nowMs();
    const rows: Record<string, unknown>[] = [];
    const bad: string[] = [];
    for (const envelope of events) {
      const event = LinkClicked.match(envelope);
      const reason = !event
        ? 'unexpected_event'
        : !isValidCode(event.payload.code)
          ? 'invalid_code'
          : Date.parse(event.payload.ts) > now + MAX_FUTURE_MS
            ? 'ts_in_future'
            : null;
      if (reason || !event) {
        this.countRejection(envelope.eventId, reason ?? 'unexpected_event');
        bad.push(reason ?? 'unexpected_event');
        continue;
      }
      const { payload } = event;
      rows.push({
        click_id: payload.clickId,
        code: payload.code,
        ts: payload.ts.replace('Z', ''),
        country: payload.country,
        referer: payload.referer,
        via_edge: payload.viaEdge ? 1 : 0,
      });
    }
    if (bad.length > 0) throw new PermanentError(bad[0]);
    const counts = await this.sink.insert('link_clicks', rows);
    linkClickProjectedCounter.add(counts.applied);
    const newest = Math.max(...events.map((e) => Date.parse(e.occurredAt)));
    if (Number.isFinite(newest))
      linkClickConsumerLagGauge.set(Math.max(0, (now - newest) / 1000));
  }

  private countRejection(eventId: string, reason: string): void {
    if (this.rejected.has(eventId)) return;
    if (this.rejected.size >= REMEMBERED_REJECTIONS) this.rejected.clear();
    this.rejected.add(eventId);
    linkClickDeadLetteredCounter.add(1, { reason });
  }
}
