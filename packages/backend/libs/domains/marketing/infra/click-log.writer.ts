import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { adClickRecordSchema } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { ADS_CLICKS_TOPIC } from '../domain/ads-constants';
import { AGGREGATOR_AUTOSTART } from './click-aggregator.service';
import {
  startBatchConsumer,
  type BatchConsumerHandle,
} from './kafka-batch-consumer';

export const CLICK_LOG_GROUP = 'ads-click-log-writer';

/**
 * `ads.clicks` -> ClickHouse `ad_clicks_log` (S53 G-44, G25): every click record, valid or not, is kept as billing evidence
 * for 400 days. Rows are never replaced at merge time; the reconciliation reads the first recorded verdict per click id
 * (`argMin` over `(received_at, ingested_at)`), so a click written twice by a retry counts once. A message that does not
 * parse is skipped here: the aggregator has already dead-lettered it. The insert carries a deduplication token made of
 * the batch's topic, partition and offsets, so a redelivered batch adds no rows.
 */
@Injectable()
export class ClickLogWriter implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ClickLogWriter.name);
  private readonly handles = new Set<BatchConsumerHandle>();

  constructor(
    private readonly config: ApiConfigService,
    private readonly sink: ClickHouseSink,
    @Inject(AGGREGATOR_AUTOSTART) private readonly autostart: boolean,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.autostart) await this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async start(groupId = CLICK_LOG_GROUP): Promise<BatchConsumerHandle> {
    const handle = await startBatchConsumer(this.config, {
      clientId: 'ads-click-log-writer',
      groupId,
      topic: ADS_CLICKS_TOPIC,
      readCommitted: false,
      handle: async ({ partition, firstOffset, lastOffset, messages }) => {
        const rows: Record<string, unknown>[] = [];
        for (const message of messages) {
          try {
            const parsed = adClickRecordSchema.safeParse(
              JSON.parse(message.value?.toString('utf8') ?? ''),
            );
            if (parsed.success) rows.push({ ...parsed.data });
          } catch {
            // dead-lettered by the aggregator
          }
        }
        await this.sink.insert('ad_clicks_log', rows, {
          dedupeToken: `${ADS_CLICKS_TOPIC}:${partition}:${firstOffset}:${lastOffset}`,
        });
      },
    });
    this.handles.add(handle);
    return handle;
  }

  async stop(): Promise<void> {
    const handles = [...this.handles];
    this.handles.clear();
    await Promise.allSettled(handles.map((h) => h.stop()));
  }
}
