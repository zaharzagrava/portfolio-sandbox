import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ingestionLagGauge } from '../domain/metrics';
import {
  FACT_REPOSITORY,
  FACT_STREAMS,
  STREAM_LAG,
  type FactRepository,
  type FactStream,
  type StreamLag,
} from '../domain/ports';

/** A topic with nothing behind it counts as read up to this long ago: events in flight are not yet on the log. */
export const IDLE_GRACE_MS = 5_000;
/** A stream further behind than this raises `statements_ingestion_lag_seconds` (a metric, never an error). */
export const LAG_ALERT_MS = 60_000;

export type Watermarks = Record<FactStream, Date | null>;

/**
 * The instant up to which every event that occurred has been applied, per stream (S16 FR-036). The stored value is the
 * latest `occurredAt` applied; when the consumer group has read the whole topic the stream is complete up to just
 * now (minus the idle grace), so a quiet topic does not hold a month open. Otherwise the stored value stands.
 */
@Injectable()
export class WatermarkService {
  constructor(
    @Inject(FACT_REPOSITORY) private readonly facts: FactRepository,
    @Inject(STREAM_LAG) private readonly lag: StreamLag,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async read(): Promise<Watermarks> {
    const stored = await this.facts.readWatermarks();
    const now = this.clock.now();
    const idle = new Date(now.getTime() - IDLE_GRACE_MS);
    const result = { ...stored };
    for (const stream of FACT_STREAMS) {
      const caughtUp = await this.lag.isCaughtUp(stream).catch(() => false);
      const current = stored[stream];
      if (caughtUp && (current === null || current.getTime() < idle.getTime()))
        result[stream] = idle;
      const mark = result[stream];
      const behindMs = mark === null ? now.getTime() : now.getTime() - mark.getTime();
      ingestionLagGauge.set(Math.max(0, behindMs) / 1000, { stream });
    }
    return result;
  }

  /** The oldest of the three: what a live statement was complete up to. `null` when a stream has applied nothing. */
  async dataAsOf(): Promise<Date | null> {
    const marks = Object.values(await this.read());
    if (marks.some((mark) => mark === null)) return null;
    return new Date(Math.min(...marks.map((mark) => mark!.getTime())));
  }
}
