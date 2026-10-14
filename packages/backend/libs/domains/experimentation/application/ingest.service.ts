import { Inject, Injectable, Logger } from '@nestjs/common';
import type { IngestResult } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { RequestContext } from '@app/infrastructure/context';
import { enrichEvent, judgeEvents } from '../domain/event-schema';
import { ingestUnavailable } from '../domain/experiment-errors';
import { EVENT_PRODUCER, type EventProducer } from '../domain/ports';
import {
  analyticsEventsTotal,
  analyticsProduceFailuresTotal,
} from './analytics-metrics';

export interface IngestMeta {
  userId?: string;
  country?: string;
  platform?: string;
}

/**
 * The fallback collector (S39 FR-006, FR-007): judges each event on its own, collapses repeated ids, enriches what is
 * accepted and answers only after the stream acknowledged all of it. If the stream does not, the whole request fails
 * `503 ingest_unavailable` and nothing is reported accepted; the client retries the same `event_id`s and the store
 * collapses them. Logs carry counts only: never props, user ids, tokens or anonymous ids.
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    @Inject(EVENT_PRODUCER) private readonly producer: EventProducer,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly context: RequestContext,
  ) {}

  async ingest(rawEvents: unknown[], meta: IngestMeta): Promise<IngestResult> {
    const { accepted, rejected } = judgeEvents(rawEvents, this.clock.nowMs());
    try {
      await this.producer.sendMany(accepted.map((e) => enrichEvent(e, meta)));
    } catch (error) {
      analyticsProduceFailuresTotal.add(1);
      this.logger.warn({
        event: 'analytics.produce_failed',
        requestId: this.context.requestId,
        events: accepted.length,
        reason: (error as Error)?.name,
      });
      throw ingestUnavailable();
    }
    if (accepted.length)
      analyticsEventsTotal.add(accepted.length, {
        outcome: 'accepted',
        reason: 'ok',
      });
    for (const { code } of rejected)
      analyticsEventsTotal.add(1, {
        outcome: code === 'duplicate_in_batch' ? code : 'rejected',
        reason: code,
      });
    this.logger.log({
      event: 'analytics.ingest',
      requestId: this.context.requestId,
      accepted: accepted.length,
      rejected: rejected.length,
    });
    return { accepted: accepted.length, rejected };
  }
}
