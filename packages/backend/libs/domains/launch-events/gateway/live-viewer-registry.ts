import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { hostname } from 'node:os';
import { CLOCK, Clock } from '@app/common/core/clock';
import { RealtimeMessage, TopicSubscriber } from '@app/infrastructure/realtime';
import { logLiveWarn } from '../application/live-log';
import { liveMetrics } from '../application/live-metrics';
import { VIEWER_REPORT_MS } from '../domain/live-constants';
import type { LiveComment } from '../domain/live-constants';
import { firehoseTopic, streamTopic } from '../domain/live-keys';
import {
  LIVE_SETTINGS,
  LIVE_TIMERS,
  VIEWER_COUNTS,
  type LiveSettings,
  type LiveTimers,
  type ViewerCounts,
} from '../domain/live-ports';
import { StreamBatcher, type LiveViewer } from './live-batcher.service';

interface Entry {
  batcher: StreamBatcher;
  unsubscribe: () => Promise<void>;
}

/**
 * Creates the batcher of a stream on its first local viewer and tears it down after its last one leaves (FR-007): one
 * subscription to the private comment feed, one to the public control topic and one sampler per (instance, stream)
 * however many viewers it serves. Reports its viewer counts to the fast store every 5 seconds for the statistics.
 */
@Injectable()
export class LiveViewerRegistry implements OnModuleDestroy {
  private readonly logger = new Logger(LiveViewerRegistry.name);
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Entry>>();
  private readonly instance = `${hostname()}-${process.pid}`;
  private readonly stopReport: () => void;
  private viewerCount = 0;

  constructor(
    private readonly hub: TopicSubscriber,
    @Inject(VIEWER_COUNTS) private readonly counts: ViewerCounts,
    @Inject(LIVE_SETTINGS) private readonly settings: LiveSettings,
    @Inject(LIVE_TIMERS) private readonly timers: LiveTimers,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.stopReport = this.timers.every(
      VIEWER_REPORT_MS,
      () =>
        void this.reportViewers().catch((error: Error) =>
          logLiveWarn(this.logger, 'viewer_count_not_reported', {}, error),
        ),
    );
  }

  /** Concurrent viewers on this instance, all streams. */
  get size(): number {
    return this.viewerCount;
  }

  isFull(): boolean {
    return this.viewerCount >= this.settings.viewerCap;
  }

  /** The batcher of a stream, when this instance serves it (specs and the controller read it). */
  batcher(streamId: string): StreamBatcher | undefined {
    return this.entries.get(streamId)?.batcher;
  }

  streamsServed(): string[] {
    return [...this.entries.keys()];
  }

  /** Adds the viewer to its stream's batcher, creating the subscriptions on the first one; returns the leave function. */
  async join(
    streamId: string,
    viewer: LiveViewer,
  ): Promise<() => Promise<void>> {
    // Counted before the first await: the cap holds under a burst of connects.
    this.viewerCount++;
    liveMetrics.viewers.set(this.viewerCount);
    let entry: Entry;
    try {
      entry = await this.entryFor(streamId);
    } catch (error) {
      this.viewerCount--;
      liveMetrics.viewers.set(this.viewerCount);
      throw error;
    }
    entry.batcher.add(viewer);

    let left = false;
    return async () => {
      if (left) return;
      left = true;
      this.viewerCount--;
      liveMetrics.viewers.set(this.viewerCount);
      entry.batcher.remove(viewer);
      if (
        entry.batcher.viewers.size === 0 &&
        this.entries.get(streamId) === entry
      )
        await this.release(streamId, entry);
    };
  }

  private entryFor(streamId: string): Promise<Entry> {
    const existing = this.entries.get(streamId);
    if (existing) return Promise.resolve(existing);
    let creating = this.pending.get(streamId);
    if (!creating) {
      creating = this.create(streamId).finally(() =>
        this.pending.delete(streamId),
      );
      this.pending.set(streamId, creating);
    }
    return creating;
  }

  private async create(streamId: string): Promise<Entry> {
    const batcher = new StreamBatcher(
      streamId,
      this.settings,
      this.timers,
      this.clock,
    );
    try {
      const unsubscribers = await Promise.all([
        this.hub.subscribe(firehoseTopic(streamId), (m: RealtimeMessage) =>
          batcher.onComment(m.data as LiveComment),
        ),
        this.hub.subscribe(streamTopic(streamId), (m: RealtimeMessage) =>
          batcher.broadcast(m.type, m.data),
        ),
      ]);
      const entry: Entry = {
        batcher,
        unsubscribe: async () =>
          void (await Promise.all(unsubscribers.map((u) => u()))),
      };
      this.entries.set(streamId, entry);
      return entry;
    } catch (error) {
      batcher.stop();
      throw error;
    }
  }

  private async release(streamId: string, entry: Entry): Promise<void> {
    this.entries.delete(streamId);
    entry.batcher.stop();
    await entry
      .unsubscribe()
      .catch((error: Error) =>
        logLiveWarn(this.logger, 'unsubscribe_failed', { streamId }, error),
      );
    await this.counts.clear(streamId, this.instance).catch(() => undefined);
  }

  /** `<count>:<ts>` per stream and instance; the statistics publisher sums fresh entries only (FR-031). */
  async reportViewers(): Promise<void> {
    const now = this.clock.nowMs();
    await Promise.all(
      [...this.entries].map(([streamId, { batcher }]) =>
        this.counts.report(streamId, this.instance, batcher.viewers.size, now),
      ),
    );
  }

  /** Graceful shutdown: viewers first (they reconnect to another instance), then the subscriptions. */
  async onModuleDestroy() {
    this.stopReport();
    for (const { batcher } of this.entries.values())
      for (const viewer of [...batcher.viewers]) viewer.close('shutdown');
    for (const [streamId, entry] of [...this.entries])
      await this.release(streamId, entry);
  }
}
