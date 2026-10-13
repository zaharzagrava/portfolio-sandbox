import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import type { KafkaMessage } from 'kafkajs';
import { adClickRecordSchema } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import {
  TransactionalPipeline,
  type PipelineBatch,
  type PipelineHandle,
  type PipelineOutput,
} from '@app/infrastructure/projections/transactional-pipeline';
import {
  ADS_AGGREGATES_TOPIC,
  ADS_CLICKS_DLQ_TOPIC,
  ADS_CLICKS_TOPIC,
  CLICK_MAX_AGE_MS,
  CLICK_MAX_FUTURE_MS,
} from '../domain/ads-constants';
import {
  adsAggregatorBatchesCounter,
  adsAggregatorFencedCounter,
  adsLateClicksCounter,
} from '../domain/ads-metrics';
import {
  aggregateBatch,
  dedupeFirstVerdict,
  isLate,
  type AggregationInput,
} from '../domain/click-aggregation';

export const AGGREGATOR_GROUP = 'ads-click-aggregator';
/** Whether the Nest lifecycle starts the aggregator; specs bind `false` and start instances themselves (fresh group ids). */
export const AGGREGATOR_AUTOSTART = Symbol('AGGREGATOR_AUTOSTART');

export interface AggregatorStartOptions {
  groupId?: string;
  transactionalId?: string;
  /** Test seam (VII.9): runs after a batch's outputs were sent and before the commit; a throw is a crash at that point. */
  afterEmit?: (batch: PipelineBatch) => Promise<void>;
}

export type RejectReason =
  | 'invalid_json'
  | 'schema'
  | 'valid_out_of_range'
  | 'received_at_future'
  | 'received_at_stale';

type Verdict =
  { ok: true; record: AggregationInput } | { ok: false; reason: RejectReason };

const FENCE_POLL_MS = 250;

/**
 * Exactly-once read-process-write (06/01 §2.2, P0603) on the S53 `TransactionalPipeline`: the aggregates of a batch and the
 * consumed offsets commit atomically under a stable transactional id (`ads_aggregator_instance`), so a crash never double
 * counts or loses a batch and a zombie instance is fenced. Every message is validated; a bad one is dead-lettered with its
 * reason inside the same transaction and never blocks the stream (FR-035). A click id counts once per batch, the minute is
 * the click's own `received_at` (late ones are measured, never moved), and the new group starts at the earliest offset.
 * A start-up failure fails the start (G22, G23): an app that silently does not aggregate would under-bill.
 */
@Injectable()
export class ClickAggregator
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ClickAggregator.name);
  private readonly running = new Set<{
    handle: PipelineHandle;
    timer: NodeJS.Timeout;
  }>();
  private fenced = false;
  private started = false;

  constructor(
    private readonly pipeline: TransactionalPipeline,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AGGREGATOR_AUTOSTART) private readonly autostart: boolean,
    @Optional() readiness?: ReadinessService,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    readiness?.register({
      name: 'ads-aggregator',
      scope: 'pod',
      check: () => {
        if (this.autostart && !this.started)
          return Promise.reject(new Error('not started'));
        if (this.fenced)
          return Promise.reject(new Error('fenced by a newer instance'));
        return Promise.resolve();
      },
    });
    shutdown?.register({
      name: 'ads.aggregator.stop',
      order: 40,
      run: () => this.stop(),
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.autostart) await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Starts one pipeline instance. A failure is thrown, never swallowed. */
  async start(options: AggregatorStartOptions = {}): Promise<PipelineHandle> {
    const instance = this.config.get('ads_aggregator_instance');
    const handle = await this.pipeline.run({
      transactionalId:
        options.transactionalId ?? `${AGGREGATOR_GROUP}-${instance}`,
      groupId: options.groupId ?? AGGREGATOR_GROUP,
      inputTopic: ADS_CLICKS_TOPIC,
      fromBeginning: true,
      handle: async (batch, emit) => {
        try {
          await this.aggregate(batch, emit);
          await options.afterEmit?.(batch);
        } catch (error) {
          adsAggregatorBatchesCounter.add(1, { result: 'failed' });
          throw error;
        }
        adsAggregatorBatchesCounter.add(1, { result: 'processed' });
      },
    });
    const entry = {
      handle,
      timer: setInterval(() => {
        if (!handle.fenced) return;
        clearInterval(entry.timer);
        this.fenced = true;
        adsAggregatorFencedCounter.add(1);
        this.logger.warn(
          'ads aggregator fenced by a newer instance with the same transactional id',
        );
      }, FENCE_POLL_MS),
    };
    entry.timer.unref();
    this.running.add(entry);
    this.started = true;
    return handle;
  }

  /** Stops fetching, ends the open transaction (aborted: the batch is read again after a restart) and disconnects. */
  async stop(): Promise<void> {
    const entries = [...this.running];
    this.running.clear();
    for (const entry of entries) clearInterval(entry.timer);
    await Promise.allSettled(entries.map((e) => e.handle.stop()));
    this.started = false;
  }

  private async aggregate(
    batch: PipelineBatch,
    emit: (topic: string, messages: PipelineOutput[]) => Promise<void>,
  ): Promise<void> {
    if (batch.messages.length === 0) return;
    const now = this.clock.nowMs();
    const accepted: AggregationInput[] = [];
    const dead: PipelineOutput[] = [];
    for (const message of batch.messages) {
      const verdict = this.classify(message, now);
      if (verdict.ok) accepted.push(verdict.record);
      else
        dead.push({
          key: message.key,
          value: message.value ?? Buffer.alloc(0),
          headers: { reason: verdict.reason },
        });
    }
    // The batch identity is the offset of its first MESSAGE, valid or not: a redelivered batch has the same identity.
    const firstOffset = Number(batch.messages[0].offset);
    const rows = aggregateBatch(batch.partition, firstOffset, accepted);

    if (dead.length > 0) await emit(ADS_CLICKS_DLQ_TOPIC, dead);
    if (rows.length > 0)
      await emit(
        ADS_AGGREGATES_TOPIC,
        rows.map((row) => ({
          key: row.campaign_id,
          value: JSON.stringify(row),
        })),
      );

    const late = dedupeFirstVerdict(accepted).filter((r) =>
      isLate(r.received_at, now),
    );
    if (late.length > 0) adsLateClicksCounter.add(late.length);
  }

  /** One message: JSON, shape, verdict range, and a receive time that is neither in the future nor too old. */
  private classify(message: KafkaMessage, nowMs: number): Verdict {
    let json: unknown;
    try {
      json = JSON.parse(message.value?.toString('utf8') ?? '');
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
    const verdictField = (json as { valid?: unknown } | null)?.valid;
    if (verdictField !== undefined && verdictField !== 0 && verdictField !== 1)
      return { ok: false, reason: 'valid_out_of_range' };
    const parsed = adClickRecordSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: 'schema' };
    const at = Date.parse(`${parsed.data.received_at.replace(' ', 'T')}Z`);
    if (at > nowMs + CLICK_MAX_FUTURE_MS)
      return { ok: false, reason: 'received_at_future' };
    if (at < nowMs - CLICK_MAX_AGE_MS)
      return { ok: false, reason: 'received_at_stale' };
    return { ok: true, record: parsed.data };
  }
}
