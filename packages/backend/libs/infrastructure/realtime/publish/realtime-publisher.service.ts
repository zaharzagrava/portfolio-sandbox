import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { RealtimeConfig } from '../config/realtime.config';
import { channelName, streamKey } from '../keys';
import { RealtimeMetrics } from '../metrics/realtime-metrics';
import { LIVE_ONLY_ID, type RealtimeTopic } from '../topics';
import { PUBLISH_SCRIPT, TRIM_SLACK } from './publish.lua';
import { validatePublish } from './publish-validation';

export interface PublishResult {
  published: boolean;
  /** The event's position (cursor) for replayable events; `null` for live-only events and when not published. */
  id: string | null;
}

const COMMAND = 'rtPublish';

/**
 * Domain code calls `publish(topic, type, data)`; the gateways deliver it to every subscribed connection on any
 * instance. Replayable events are stored in a short per-topic stream and announced in one atomic script (the live
 * message carries the stream position); live-only events are a plain `PUBLISH`. Best effort: a store fault or a slow
 * store resolves `{ published: false, id: null }` after one attempt, never throwing into the business flow. Invalid
 * input rejects with a typed error before the store is touched.
 */
@Injectable()
export class RealtimePublisher {
  private readonly logger = new Logger(RealtimePublisher.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: RealtimeConfig,
    private readonly metrics: RealtimeMetrics,
  ) {
    this.redis.client.defineCommand(COMMAND, {
      numberOfKeys: 2,
      lua: PUBLISH_SCRIPT,
    });
  }

  async publish<T>(
    topic: RealtimeTopic,
    type: string,
    data: T,
    { replay = true }: { replay?: boolean } = {},
  ): Promise<PublishResult> {
    let payload: string;
    try {
      payload = validatePublish(
        topic,
        type,
        data,
        this.config.get('maxPayloadBytes'),
      );
    } catch (error) {
      this.metrics.published.add(1, { result: 'rejected' });
      throw error;
    }

    const command = replay
      ? this.scripted(topic, type, payload)
      : this.liveOnly(topic, type, payload);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('publish timed out')),
        this.config.get('publishTimeoutMs'),
      );
    });
    try {
      const id = await Promise.race([command, timeout]);
      this.metrics.published.add(1, { result: 'ok' });
      return { published: true, id };
    } catch (error) {
      // The losing command may still settle; keep it from becoming an unhandled rejection.
      command.catch(() => undefined);
      this.metrics.published.add(1, { result: 'failed' });
      this.logger.warn(
        `realtime publish failed topic=${topic} type=${type}: ${(error as Error).message}`,
      );
      return { published: false, id: null };
    } finally {
      clearTimeout(timer);
    }
  }

  private async scripted(
    topic: string,
    type: string,
    payload: string,
  ): Promise<string> {
    const client = this.redis.client as unknown as Record<
      string,
      (...args: (string | number)[]) => Promise<string>
    >;
    return client[COMMAND](
      streamKey(topic),
      channelName(topic),
      topic,
      type,
      payload,
      this.config.get('retentionCount'),
      this.config.get('retentionMs'),
      TRIM_SLACK,
    );
  }

  private async liveOnly(
    topic: string,
    type: string,
    payload: string,
  ): Promise<string | null> {
    await this.redis.client.publish(
      channelName(topic),
      `{"id":"${LIVE_ONLY_ID}","topic":${JSON.stringify(topic)},"type":${JSON.stringify(type)},"data":${payload}}`,
    );
    return null;
  }
}
