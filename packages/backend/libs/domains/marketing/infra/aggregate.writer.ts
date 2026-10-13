import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { minuteAggregateSchema } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { ClickHouseSink } from '@app/infrastructure/projections/sinks/clickhouse.sink';
import { ADS_AGGREGATES_TOPIC } from '../domain/ads-constants';
import { AGGREGATOR_AUTOSTART } from './click-aggregator.service';
import {
  startBatchConsumer,
  type BatchConsumerHandle,
} from './kafka-batch-consumer';

export const AGGREGATE_WRITER_GROUP = 'ads-aggregate-writer';

/**
 * `ads.click-aggregates` -> ClickHouse `ad_click_minute_v2` (S53 G-44, FR-033). Reads only committed transactional output
 * (`read_committed`), so an aborted batch never reaches billing. The key `(campaign, minute, source partition, first
 * offset)` makes a redelivered aggregate replace its row; the insert token (topic, partition, offsets) lets the server
 * drop a redelivered batch before any merge. The hourly job sums the salted partials of a campaign-minute.
 */
@Injectable()
export class AggregateWriter
  implements OnApplicationBootstrap, OnModuleDestroy
{
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

  async start(groupId = AGGREGATE_WRITER_GROUP): Promise<BatchConsumerHandle> {
    const handle = await startBatchConsumer(this.config, {
      clientId: 'ads-aggregate-writer',
      groupId,
      topic: ADS_AGGREGATES_TOPIC,
      readCommitted: true,
      handle: async ({ partition, firstOffset, lastOffset, messages }) => {
        const rows: Record<string, unknown>[] = [];
        for (const message of messages) {
          try {
            const parsed = minuteAggregateSchema.safeParse(
              JSON.parse(message.value?.toString('utf8') ?? ''),
            );
            if (parsed.success) rows.push({ ...parsed.data });
          } catch {
            // only the aggregator writes this topic; an unreadable message is a defect, not data
          }
        }
        await this.sink.insert('ad_click_minute_v2', rows, {
          dedupeToken: `${ADS_AGGREGATES_TOPIC}:${partition}:${firstOffset}:${lastOffset}`,
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
