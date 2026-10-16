import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { CLOCK, Clock } from '@app/common/core/clock';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { LiveEventLog } from '../application/live-event-log';
import { logLiveWarn } from '../application/live-log';
import { liveMetrics } from '../application/live-metrics';
import { LiveStateCache } from '../application/live-state-cache';
import { TICK_MS } from '../domain/live-constants';
import { streamTopic } from '../domain/live-keys';
import {
  ACTIVE_STREAM_SET,
  LIVE_TIMERS,
  REACTION_COUNTERS,
  TICKER_COORDINATION,
  VIEWER_COUNTS,
  type ActiveStreams,
  type LiveTimers,
  type ReactionCounters,
  type TickerCoordination,
  type ViewerCounts,
} from '../domain/live-ports';

/**
 * Once per second per live stream: sum the 8 reaction shards of the second that just finished and the gateways' viewer
 * counts into one `stats` event on `stream:{id}` (FR-030). A per-stream lease picks ONE worker per stream, so N workers
 * split the streams; a per-(stream, second) marker keeps a second from being published twice. Non-empty totals are also
 * emitted once as `live.reactions_aggregated` (FR-032). A stream that is not `LIVE` any more leaves the active set.
 */
@Injectable()
export class LiveTicker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LiveTicker.name);
  private readonly me = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly leased = new Set<string>();
  private stop?: () => void;

  constructor(
    @Inject(ACTIVE_STREAM_SET) private readonly active: ActiveStreams,
    @Inject(TICKER_COORDINATION)
    private readonly coordination: TickerCoordination,
    @Inject(REACTION_COUNTERS) private readonly counters: ReactionCounters,
    @Inject(VIEWER_COUNTS) private readonly viewers: ViewerCounts,
    private readonly state: LiveStateCache,
    private readonly realtime: RealtimePublisher,
    private readonly events: LiveEventLog,
    @Inject(LIVE_TIMERS) private readonly timers: LiveTimers,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onApplicationBootstrap() {
    this.stop = this.timers.every(
      TICK_MS,
      () =>
        void this.tick().catch((error: Error) =>
          logLiveWarn(this.logger, 'tick_failed', {}, error),
        ),
    );
  }

  /** Graceful stop: the leases go at once, so another worker takes the streams over without waiting for them to expire. */
  async onModuleDestroy() {
    this.stop?.();
    await this.releaseLeases();
  }

  async releaseLeases(): Promise<void> {
    await Promise.all(
      [...this.leased].map((streamId) =>
        this.coordination
          .releaseLease(streamId, this.me)
          .catch(() => undefined),
      ),
    );
    this.leased.clear();
  }

  /** One pass over the active streams; returns how many `stats` this instance published. */
  async tick(): Promise<number> {
    const now = this.clock.nowMs();
    const second = Math.floor(now / 1000) - 1;
    let published = 0;
    for (const streamId of await this.active.list()) {
      try {
        if (await this.publishFor(streamId, second, now)) published++;
      } catch (error) {
        logLiveWarn(this.logger, 'stats_failed', { streamId }, error);
      }
    }
    return published;
  }

  private async publishFor(
    streamId: string,
    second: number,
    now: number,
  ): Promise<boolean> {
    if (!(await this.coordination.holdLease(streamId, this.me))) return false;
    this.leased.add(streamId);
    const stream = await this.state.get(streamId);
    if (!stream || stream.status !== 'LIVE') {
      // Ended or unknown: nobody publishes for it, and it leaves the set (the reconcile job would remove it too).
      await this.active.remove(streamId);
      await this.coordination.releaseLease(streamId, this.me);
      this.leased.delete(streamId);
      return false;
    }
    if (!(await this.coordination.claimStats(streamId, second))) return false;

    const totals = await this.counters.totals(streamId, second);
    const reactions = Object.fromEntries(
      Object.entries(totals).filter(([, count]) => count > 0),
    );
    const viewers = await this.viewers.total(streamId, now);
    await this.realtime.publish(
      streamTopic(streamId),
      'stats',
      { second, reactions, viewers },
      { replay: false },
    );
    liveMetrics.statsPublished.add(1);

    if (Object.keys(reactions).length > 0)
      await this.aggregate(streamId, second, reactions);
    return true;
  }

  private async aggregate(
    streamId: string,
    second: number,
    reactions: Record<string, number>,
  ): Promise<void> {
    if (!(await this.coordination.claimAggregation(streamId, second))) return;
    try {
      await this.events.reactionsAggregated(streamId, second, reactions);
    } catch (error) {
      // Reactions are lossy by design; release the marker so a repeat of this second can still emit it.
      await this.coordination
        .releaseAggregation(streamId, second)
        .catch(() => undefined);
      logLiveWarn(this.logger, 'reactions_not_aggregated', { streamId }, error);
    }
  }
}
