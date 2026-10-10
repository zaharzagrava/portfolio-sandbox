import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type { Consumer, EachBatchPayload } from 'kafkajs';
import { ApiConfigService } from '@app/common/config';
import { fullJitterBackoff, sleep } from '@app/common/core/backoff';
import { ANALYTICS_TOPIC } from '@app/domains/experimentation';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';
import {
  KAFKA_CONSUMER_OVERRIDES,
  type KafkaClientOverrides,
} from '@app/infrastructure/kafka/kafka-client.options';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { trendingConnectFailures } from '../application/trending-metrics';
import {
  TRENDING_CONSUMER_NAME,
  TrendingIngestService,
} from '../application/trending-ingest.service';
import { TrendingSettings } from './trending-config';
import { withBudget } from './with-budget';

export interface TrendingConsumerOptions {
  groupId: string;
  topic: string;
  fromBeginning: boolean;
}

/** Production values; specs bind their own (a fresh group and topic per test). */
export const TRENDING_CONSUMER_OPTIONS = Symbol('TRENDING_CONSUMER_OPTIONS');
export const DEFAULT_TRENDING_CONSUMER_OPTIONS: TrendingConsumerOptions = {
  groupId: TRENDING_CONSUMER_NAME,
  topic: ANALYTICS_TOPIC,
  fromBeginning: false,
};

/** How the process ends when the consumer loop is dead (the supervisor restarts it). Specs bind a spy. */
export const TRENDING_PROCESS_EXIT = Symbol('TRENDING_PROCESS_EXIT');
export type ProcessExit = (code: number) => void;

const CONNECT_BACKOFF = { baseMs: 500, maxMs: 10_000 };

type BatchPayload = Pick<
  EachBatchPayload,
  'batch' | 'resolveOffset' | 'heartbeat' | 'isRunning' | 'isStale'
>;

/**
 * The kafkajs loop of trending (S35 R-1, R-14, R-15). It owns offsets: `autoCommit` is off and only the commit floor of
 * the ingest service is ever committed. Connect and subscribe run in a retry loop (a timeout per call, full-jitter
 * backoff, each failure counted, nothing swallowed); readiness is true only after the loop started; a dead loop turns
 * readiness off and ends the process. On shutdown it stops fetching, merges every open window, commits the floor and
 * disconnects.
 */
@Injectable()
export class TrendingConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TrendingConsumer.name);
  private readonly options: TrendingConsumerOptions;
  private readonly committed = new Map<number, number>();
  private consumer?: Consumer;
  private assigned: number[] = [];
  private paused = false;
  private ready = false;
  private stopped = false;
  private ticking = false;
  private active = 0;
  private timer?: NodeJS.Timeout;
  private started?: Promise<void>;
  private resolveReady!: () => void;
  private readonly readyPromise = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });

  constructor(
    private readonly config: ApiConfigService,
    private readonly settings: TrendingSettings,
    private readonly ingest: TrendingIngestService,
    @Optional() private readonly readiness?: ReadinessService,
    @Optional() private readonly shutdown?: ShutdownRegistry,
    @Optional()
    @Inject(TRENDING_CONSUMER_OPTIONS)
    options?: TrendingConsumerOptions,
    @Optional()
    @Inject(TRENDING_PROCESS_EXIT)
    private readonly exit: ProcessExit = (code) => process.exit(code),
    @Optional()
    @Inject(KAFKA_CONSUMER_OVERRIDES)
    private readonly overrides: KafkaClientOverrides = {},
  ) {
    this.options = options ?? DEFAULT_TRENDING_CONSUMER_OPTIONS;
  }

  onApplicationBootstrap(): void {
    this.readiness?.register({
      name: 'trending-consumer',
      scope: 'pod',
      check: () =>
        this.ready
          ? Promise.resolve()
          : Promise.reject(new Error('trending consumer is not subscribed')),
    });
    this.shutdown?.register({
      name: 'trending.drain',
      order: 10,
      phase: 'drain',
      timeoutMs: this.settings.shutdownDeadlineMs,
      run: () => this.stop(),
    });
    // Not awaited: a broker that is down must not keep the application from starting; readiness says "not ready".
    this.started = this.connectLoop().catch((error: Error) =>
      this.logger.error(`consumer start ended: ${error.name}`),
    );
    this.timer = setInterval(() => void this.tickNow(), this.settings.tickMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Resolves once the consumer is subscribed and its loop started. */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  /** The idle clock and a merge cycle, then the floor. Public so a spec drives it with its own clock. */
  async tickNow(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      await this.ingest.tick();
      await this.commit();
      if (this.paused && !this.ingest.overBudget()) this.resume();
    } catch (error) {
      this.logger.warn(`tick failed: ${(error as Error).name}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Graceful stop: stop fetching, merge all open windows, commit the floor, disconnect. Safe to call twice. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    if (this.timer) clearInterval(this.timer);
    await this.started?.catch(() => undefined);
    if (!this.consumer) return;
    try {
      this.consumer.pause(
        this.assigned.map((partition) => ({
          topic: this.options.topic,
          partitions: [partition],
        })),
      );
      await this.ingest.drain();
      await this.commit(true);
    } catch (error) {
      this.logger.warn(`drain failed: ${(error as Error).name}`);
    } finally {
      await this.consumer.disconnect().catch(() => undefined);
    }
  }

  /** Test seam for a crash: the connection is dropped with no final merge and no commit. */
  async abandon(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    if (this.timer) clearInterval(this.timer);
    await this.started?.catch(() => undefined);
    await this.consumer?.disconnect().catch(() => undefined);
  }

  /** Batches being processed right now (introspection for specs). */
  activeBatches(): number {
    return this.active;
  }

  /** One fetched batch; the loop's `eachBatch`. */
  async onBatch(payload: BatchPayload): Promise<void> {
    this.active++;
    try {
      await this.processBatch(payload);
    } finally {
      this.active--;
    }
  }

  private async processBatch({
    batch,
    resolveOffset,
    heartbeat,
    isRunning,
    isStale,
  }: BatchPayload): Promise<void> {
    for (const message of batch.messages) {
      if (!isRunning() || isStale()) return; // the rest is redelivered
      await this.ingest.ingest({
        topic: batch.topic,
        partition: batch.partition,
        offset: Number(message.offset),
        key: message.key,
        value: message.value,
      });
      resolveOffset(message.offset);
    }
    await this.ingest.afterBatch();
    await this.commit();
    const high = Number(batch.highWatermark);
    if (Number.isFinite(high))
      this.ingest.setLag(
        batch.partition,
        high - (Number(batch.lastOffset()) + 1),
      );
    await heartbeat();
    if (this.ingest.overBudget()) this.pauseAll();
  }

  // ---- connecting ----------------------------------------------------------------------------------------------

  private async connectLoop(): Promise<void> {
    for (let attempt = 0; !this.stopped; attempt++) {
      const consumer = createKafka(
        this.config,
        'trending',
        this.overrides,
      ).consumer({
        groupId: this.options.groupId,
        maxBytesPerPartition: 4 * 1024 * 1024,
        // a failed loop is final: this process reports not ready and exits instead of retrying in the dark
        retry: { restartOnFailure: () => Promise.resolve(false) },
      });
      this.consumer = consumer;
      consumer.on(consumer.events.CRASH, () => this.onLoopDead());
      consumer.on(consumer.events.GROUP_JOIN, (event) => {
        this.assigned =
          (event.payload.memberAssignment as Record<string, number[]>)[
            this.options.topic
          ] ?? [];
        // after a rebalance the group resumes from the committed floor: state is rebuilt from there (as after a restart)
        this.committed.clear();
        this.ingest.reset();
      });
      try {
        const budget = this.settings.connectTimeoutMs;
        await withBudget(consumer.connect(), budget);
        await withBudget(
          consumer.subscribe({
            topic: this.options.topic,
            fromBeginning: this.options.fromBeginning,
          }),
          budget,
        );
        await consumer.run({
          autoCommit: false,
          eachBatch: (payload) => this.onBatch(payload),
        });
        if (this.stopped) return;
        this.ready = true;
        this.resolveReady();
        return;
      } catch (error) {
        trendingConnectFailures.add(1);
        this.logger.warn(
          `consumer connect/subscribe failed (attempt ${attempt + 1}): ${(error as Error).name}`,
        );
        await consumer.disconnect().catch(() => undefined);
        if (this.stopped) return;
        await sleep(fullJitterBackoff(attempt, CONNECT_BACKOFF));
      }
    }
  }

  private onLoopDead(): void {
    if (this.stopped) return;
    this.ready = false;
    this.logger.error(
      'consumer loop ended; exiting so the supervisor restarts it',
    );
    this.exit(1);
  }

  // ---- offsets and flow control ---------------------------------------------------------------------------------

  private async commit(final = false): Promise<void> {
    if (!this.consumer || (!this.ready && !final)) return;
    const due = this.ingest
      .floors()
      .filter((f) => f.offset > (this.committed.get(f.partition) ?? -1));
    if (due.length === 0) return;
    try {
      await this.consumer.commitOffsets(
        due.map((f) => ({
          topic: this.options.topic,
          partition: f.partition,
          offset: String(f.offset),
        })),
      );
      for (const f of due) this.committed.set(f.partition, f.offset);
    } catch (error) {
      // during a rebalance a commit may be refused; the next batch or tick commits again
      this.logger.warn(`offset commit failed: ${(error as Error).name}`);
    }
  }

  private pauseAll(): void {
    if (this.paused || !this.consumer) return;
    this.paused = true;
    this.consumer.pause(
      this.assigned.map((partition) => ({
        topic: this.options.topic,
        partitions: [partition],
      })),
    );
  }

  private resume(): void {
    if (!this.consumer) return;
    this.paused = false;
    this.consumer.resume(
      this.assigned.map((partition) => ({
        topic: this.options.topic,
        partitions: [partition],
      })),
    );
  }
}
