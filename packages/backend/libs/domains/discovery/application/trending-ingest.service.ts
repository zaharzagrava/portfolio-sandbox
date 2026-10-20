import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { storedAnalyticsEventSchema } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { fullJitterBackoff, sleep } from '@app/common/core/backoff';
import { DeadLetterWriter } from '@app/infrastructure/projections/dead-letter';
import { commitFloor } from '../domain/commit-floor';
import { CountMinSketch } from '../domain/count-min-sketch';
import { TopK } from '../domain/top-k';
import { PartitionWindows, type WindowEntry } from '../domain/tumbling-windows';
import { normalise, type CountedEvent } from '../domain/trending-event';
import {
  TRENDING_AGGREGATE_WRITER,
  TRENDING_SETTINGS,
  type CorrectionEvent,
  type TrendingAggregateWriter,
} from '../domain/trending-ports';
import type { TrendingSettingsValues } from '../domain/trending-config';
import { WindowCaps } from '../domain/visitor-cap';
import {
  trendingConsumerLag,
  trendingEvents,
  trendingLastMerge,
  trendingMerges,
  trendingOldestUnmergedAge,
  trendingTrackedBytes,
  trendingWindowsClosed,
} from './trending-metrics';

export const TRENDING_CONSUMER_NAME = 'discovery-trending-topk';
/** Source of the full-jitter backoff between merge attempts: specs script it, production uses `Math.random`. */
export const TRENDING_RANDOM = Symbol('TRENDING_RANDOM');

const WINDOW_MS = 60_000;
const HORIZON_MS = 3_600_000;
const MERGE_ATTEMPTS = 3;
const BACKOFF_CAP_MS = 2_000;
/** Rough size of one buffered late event, so a flood of them also counts against the memory budget. */
const CORRECTION_EVENT_BYTES = 160;
/** Rough size of one counted event id kept until its window is merged. */
const EVENT_ID_BYTES = 64;
/** At this share of the budget no new category sketch is opened. */
const SOFT_LIMIT = 0.8;

/** One delivered message of the analytics topic, as the consumer hands it over. */
export interface IngestMessage {
  topic: string;
  partition: number;
  offset: number;
  key: Buffer | null;
  value: Buffer | null;
}

interface SketchPair {
  cms: CountMinSketch;
  top: TopK;
}

interface WindowState {
  sketches: Map<string, SketchPair>;
  caps: WindowCaps;
  /** Ids counted in this window: claimed with the merge, so a copy that arrives after the window closed changes nothing. */
  eventIds: string[];
  bytes: number;
  reported: boolean;
}

interface CorrectionBuffer {
  events: CorrectionEvent[];
  categories: Set<string>;
  firstOffset: number;
  lastOffset: number;
}

interface PartitionState {
  windows: PartitionWindows<WindowState>;
  corrections: Map<number, CorrectionBuffer>;
  lastConsumed: number | null;
}

/**
 * The count half of trending (S35 FR-011 to FR-022), one instance per consumer process. For every delivered message it
 * validates, normalises, applies the duplicate and per-visitor caps, classifies the event against its partition's
 * watermark and counts it into a Count-Min Sketch plus min-heap per tracked category and `all` (open window) or into a
 * correction buffer (closed window inside the horizon). Closed windows are merged into the shared aggregate by one atomic
 * idempotent call each, retried up to three times with full jitter (the only retry layer). Offsets are committed only up
 * to `floors()`: the earliest offset of any unmerged window, so a crash loses nothing and the idempotent merge makes the
 * replay harmless. No identifier of a visitor, event or product reaches a log line or a metric label.
 */
@Injectable()
export class TrendingIngestService {
  private readonly logger = new Logger(TrendingIngestService.name);
  private readonly partitions = new Map<number, PartitionState>();
  private readonly lags = new Map<number, number>();
  private trackedBytes = 0;
  private mergeChain: Promise<void> = Promise.resolve();
  private stopping = false;
  /** Bumped by `reset()`: a merge cycle that started before it must not touch the memory counter afterwards. */
  private generation = 0;

  constructor(
    @Inject(TRENDING_SETTINGS)
    private readonly settings: TrendingSettingsValues,
    @Inject(TRENDING_AGGREGATE_WRITER)
    private readonly writer: TrendingAggregateWriter,
    private readonly deadLetters: DeadLetterWriter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional()
    @Inject(TRENDING_RANDOM)
    private readonly random: () => number = Math.random,
  ) {}

  // ---- per message --------------------------------------------------------------------------------------------

  /** Handles one message. Throws only when a dead letter cannot be written (the offset must then not be committed). */
  async ingest(message: IngestMessage): Promise<void> {
    const state = this.partition(message.partition);
    const outcome = await this.handle(message, state);
    if (outcome !== undefined) trendingEvents.add(1, { outcome });
    state.lastConsumed = Math.max(state.lastConsumed ?? -1, message.offset);
  }

  private async handle(
    message: IngestMessage,
    state: PartitionState,
  ): Promise<string | undefined> {
    let json: unknown;
    try {
      json = JSON.parse(message.value?.toString('utf8') ?? '');
    } catch {
      await this.deadLetter(message, 'payload is not JSON');
      return 'invalid';
    }
    const parsed = storedAnalyticsEventSchema.safeParse(json);
    if (!parsed.success) {
      const paths = [
        ...new Set(
          parsed.error.issues.map((i) => i.path.join('.') || '(root)'),
        ),
      ];
      await this.deadLetter(message, `schema violation at ${paths.join(', ')}`);
      return 'invalid';
    }
    const event = normalise(parsed.data, this.settings);
    if (event.kind === 'invalid') {
      await this.deadLetter(message, event.reason);
      return 'invalid';
    }
    const now = this.clock.nowMs();
    const times =
      event.kind === 'ignored'
        ? event
        : { eventTimeMs: event.eventTimeMs, receivedAtMs: event.receivedAtMs };
    // judged against the watermark BEFORE this message moves it
    const classification =
      event.kind === 'count'
        ? state.windows.classify(event.eventTimeMs, now)
        : undefined;
    state.windows.observe({ ...times, nowMs: now });
    if (event.kind === 'ignored') return 'ignored';

    if (classification === 'late_dropped') return 'late_dropped';
    if (classification === 'late_corrected') {
      this.buffer(state, event, message.offset);
      return 'late_corrected';
    }
    const entry = state.windows.open(event.eventTimeMs, message.offset);
    const admission = entry.state.caps.admit(
      event.eventId,
      event.visitorId,
      event.name,
      event.productId,
    );
    if (admission === 'duplicate') return 'duplicate';
    if (admission === 'visitor_capped') return 'visitor_capped';
    if (event.categoryRejected)
      trendingEvents.add(1, { outcome: 'category_rejected' });
    this.count(entry.state, event);
    entry.state.eventIds.push(event.eventId);
    entry.state.bytes += EVENT_ID_BYTES;
    this.trackedBytes += EVENT_ID_BYTES;
    return 'counted';
  }

  private count(window: WindowState, event: CountedEvent): void {
    this.offer(window.sketches.get('all')!, event);
    if (event.category === null) return;
    let pair = window.sketches.get(event.category);
    if (!pair) {
      const bytes = this.categoryBytes();
      const tracked = window.sketches.size - 1;
      if (
        tracked >= this.settings.categoryCap ||
        this.trackedBytes + bytes > SOFT_LIMIT * this.budgetBytes()
      ) {
        trendingEvents.add(1, { outcome: 'category_capped' });
        return;
      }
      pair = this.newPair(this.settings.categoryWidth);
      window.sketches.set(event.category, pair);
      window.bytes += bytes;
      this.trackedBytes += bytes;
      trendingTrackedBytes.set(this.trackedBytes);
    }
    this.offer(pair, event);
  }

  private offer(pair: SketchPair, event: CountedEvent): void {
    pair.top.offer(
      event.productId,
      pair.cms.add(event.productId, event.weight),
    );
  }

  private buffer(
    state: PartitionState,
    event: CountedEvent,
    offset: number,
  ): void {
    const start = event.eventTimeMs - (event.eventTimeMs % WINDOW_MS);
    let buf = state.corrections.get(start);
    if (!buf) {
      buf = {
        events: [],
        categories: new Set(),
        firstOffset: offset,
        lastOffset: offset,
      };
      state.corrections.set(start, buf);
    }
    buf.firstOffset = Math.min(buf.firstOffset, offset);
    buf.lastOffset = Math.max(buf.lastOffset, offset);
    const categories = ['all'];
    if (
      event.category !== null &&
      (buf.categories.has(event.category) ||
        buf.categories.size < this.settings.categoryCap)
    ) {
      buf.categories.add(event.category);
      categories.push(event.category);
    }
    buf.events.push({
      eventId: event.eventId,
      productId: event.productId,
      weight: event.weight,
      categories,
    });
    this.trackedBytes += CORRECTION_EVENT_BYTES;
    trendingTrackedBytes.set(this.trackedBytes);
  }

  private async deadLetter(message: IngestMessage, reason: string) {
    await this.deadLetters.write({
      consumer: TRENDING_CONSUMER_NAME,
      topic: message.topic,
      partition: message.partition,
      offset: String(message.offset),
      key: message.key,
      value: message.value,
      code: 'INVALID_PAYLOAD',
      reason,
      attempts: 0,
    });
  }

  // ---- merging ------------------------------------------------------------------------------------------------

  /** After a batch: close what the watermark closed and merge it (and the buffered corrections). */
  async afterBatch(): Promise<void> {
    await this.mergeCycle(false);
  }

  /** The timer: idle partitions advance with the wall clock, then the same cycle. */
  async tick(): Promise<void> {
    const now = this.clock.nowMs();
    for (const state of this.partitions.values()) state.windows.tick(now);
    await this.mergeCycle(false);
  }

  /** Shutdown: every open window of the owned partitions is closed and merged (one attempt cycle each). */
  async drain(): Promise<void> {
    this.stopping = true;
    await this.mergeCycle(true);
  }

  private mergeCycle(force: boolean): Promise<void> {
    const run = this.mergeChain.then(() => this.runMergeCycle(force));
    this.mergeChain = run.catch(() => undefined);
    return run;
  }

  private async runMergeCycle(force: boolean): Promise<void> {
    const generation = this.generation;
    const release = (bytes: number) => {
      if (generation === this.generation) this.trackedBytes -= bytes;
    };
    for (const [partition, state] of [...this.partitions].sort(
      (a, b) => a[0] - b[0],
    )) {
      const ready = force
        ? state.windows.closeAll()
        : state.windows.closeReady();
      for (const entry of ready) {
        if (!entry.state.reported) {
          entry.state.reported = true;
          trendingWindowsClosed.add(1);
        }
      }
      for (const entry of ready) {
        if (!(await this.mergeWindow(partition, state, entry, release))) break; // keep window order
      }
      await this.mergeCorrections(state, release);
    }
    this.updateGauges();
  }

  private async mergeWindow(
    partition: number,
    state: PartitionState,
    entry: WindowEntry<WindowState>,
    release: (bytes: number) => void,
  ): Promise<boolean> {
    const categories = [...entry.state.sketches].map(([category, pair]) => ({
      category,
      entries: pair.top
        .top()
        .map((e) => ({ productId: e.key, score: e.count })),
    }));
    const outcome = await this.attempt(() =>
      this.writer.mergeWindow({
        partition,
        windowStartMs: entry.start,
        firstOffset: entry.firstOffset,
        lastOffset: entry.lastOffset,
        categories: categories.filter((c) => c.entries.length > 0),
        eventIds: entry.state.eventIds,
      }),
    );
    if (outcome === null) {
      trendingMerges.add(1, { outcome: 'merge_failed' });
      return false;
    }
    trendingMerges.add(1, {
      outcome: outcome === 'applied' ? 'merged' : 'merge_replayed',
    });
    trendingLastMerge.set(this.clock.nowMs() / 1000);
    state.windows.markMerged(entry.start);
    release(entry.state.bytes);
    return true;
  }

  private async mergeCorrections(
    state: PartitionState,
    release: (bytes: number) => void,
  ): Promise<void> {
    for (const [start, buf] of [...state.corrections].sort(
      (a, b) => a[0] - b[0],
    )) {
      const events = buf.events.slice();
      const result = await this.attempt(() =>
        this.writer.mergeCorrections({ windowStartMs: start, events }),
      );
      if (result === null) {
        trendingMerges.add(1, { outcome: 'merge_failed' });
        return;
      }
      trendingMerges.add(1, { outcome: 'merged' });
      trendingLastMerge.set(this.clock.nowMs() / 1000);
      // events buffered while the call was in flight stay for the next cycle
      buf.events.splice(0, events.length);
      release(events.length * CORRECTION_EVENT_BYTES);
      if (buf.events.length === 0) state.corrections.delete(start);
    }
  }

  /** Up to three attempts with full-jitter backoff; `null` when all failed. Nothing about the data is logged. */
  private async attempt<T>(call: () => Promise<T>): Promise<T | null> {
    for (let n = 0; n < MERGE_ATTEMPTS; n++) {
      try {
        return await call();
      } catch (error) {
        this.logger.warn(
          `merge attempt ${n + 1}/${MERGE_ATTEMPTS} failed: ${(error as Error).name}`,
        );
        if (n < MERGE_ATTEMPTS - 1 && !this.stopping)
          await sleep(
            fullJitterBackoff(
              n,
              {
                baseMs: this.settings.mergeBackoffBaseMs,
                maxMs: BACKOFF_CAP_MS,
              },
              this.random,
            ),
          );
      }
    }
    return null;
  }

  // ---- offsets, memory, partitions -----------------------------------------------------------------------------

  /** The offset each consumed partition may commit now. */
  floors(): { partition: number; offset: number }[] {
    const out: { partition: number; offset: number }[] = [];
    for (const [partition, state] of this.partitions) {
      const pending = [
        ...state.windows.firstOffsets(),
        ...[...state.corrections.values()].map((b) => b.firstOffset),
      ];
      const offset = commitFloor(state.lastConsumed, pending);
      if (offset !== null) out.push({ partition, offset });
    }
    return out.sort((a, b) => a.partition - b.partition);
  }

  /** The last offset consumed per partition (introspection for specs and the lag gauge). */
  positions(): Map<number, number> {
    const out = new Map<number, number>();
    for (const [partition, state] of this.partitions)
      if (state.lastConsumed !== null) out.set(partition, state.lastConsumed);
    return out;
  }

  /** True once the open windows hold the whole memory budget: the consumer pauses its partitions until a merge frees it. */
  overBudget(): boolean {
    return this.trackedBytes >= this.budgetBytes();
  }

  /**
   * After a rebalance the group resumes from the committed floors, so everything held in memory is dropped and rebuilt by
   * the replay, exactly as after a restart (retaining it would count the replayed events twice). The idempotent merge
   * makes the rebuilt windows harmless.
   */
  reset(): void {
    this.generation++;
    this.partitions.clear();
    this.lags.clear();
    this.trackedBytes = 0;
    this.updateGauges();
  }

  setLag(partition: number, lag: number): void {
    this.lags.set(partition, Math.max(0, lag));
    trendingConsumerLag.set([...this.lags.values()].reduce((a, b) => a + b, 0));
  }

  private partition(id: number): PartitionState {
    let state = this.partitions.get(id);
    if (!state) {
      state = {
        windows: new PartitionWindows<WindowState>(
          {
            windowMs: WINDOW_MS,
            latenessMs: this.settings.latenessSeconds * 1000,
            idleMs: this.settings.idleSeconds * 1000,
            horizonMs: HORIZON_MS,
          },
          () => this.newWindow(),
        ),
        corrections: new Map(),
        lastConsumed: null,
      };
      this.partitions.set(id, state);
    }
    return state;
  }

  private newWindow(): WindowState {
    const caps = new WindowCaps(this.settings.filterBits);
    const all = this.newPair(this.settings.allWidth);
    const bytes = caps.byteSize + all.cms.byteSize;
    this.trackedBytes += bytes;
    trendingTrackedBytes.set(this.trackedBytes);
    return {
      sketches: new Map([['all', all]]),
      caps,
      eventIds: [],
      bytes,
      reported: false,
    };
  }

  private newPair(width: number): SketchPair {
    return {
      cms: new CountMinSketch(width, this.settings.depth),
      top: new TopK(this.settings.heapK),
    };
  }

  private categoryBytes(): number {
    return this.settings.categoryWidth * this.settings.depth * 4;
  }

  private budgetBytes(): number {
    return this.settings.memoryBudgetMb * 1024 * 1024;
  }

  private updateGauges(): void {
    trendingTrackedBytes.set(this.trackedBytes);
    let oldest: number | null = null;
    for (const state of this.partitions.values()) {
      const start = state.windows.oldestStart();
      if (start !== null && (oldest === null || start < oldest)) oldest = start;
    }
    trendingOldestUnmergedAge.set(
      oldest === null ? 0 : Math.max(0, (this.clock.nowMs() - oldest) / 1000),
    );
  }
}
