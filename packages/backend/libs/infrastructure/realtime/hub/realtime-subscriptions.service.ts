import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { RealtimeConfig } from '../config/realtime.config';
import { CHANNEL_PREFIX, CONTROL_CHANNEL } from '../keys';
import { RealtimeUnavailableError } from '../errors';
import { isValidPrefix, parseTopicShape } from '../topics';
import type { RevocationNotice } from './subscription-hub';

const withTimeout = <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${ms} ms`)),
      ms,
    );
  });
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Server-side commands about who is listening (S51 FR-039). `revoke` is a command to every instance, best effort over
 * the backplane and not a ban: the topic's rule still decides a reconnect. A store fault rejects
 * `RealtimeUnavailableError`, so a retrying caller (a projector) can try again.
 */
@Injectable()
export class RealtimeSubscriptions {
  private readonly logger = new Logger(RealtimeSubscriptions.name);

  constructor(
    private readonly redis: RedisService,
    private readonly config: RealtimeConfig,
  ) {}

  /**
   * Topics of one route that have a listener on any instance (S51 FR-042): the backplane's own list of channels with
   * subscribers, sorted and capped. A store fault or a late answer rejects `RealtimeUnavailableError`.
   */
  async topicsWithSubscribers(
    prefix: string,
    suffix?: string,
  ): Promise<string[]> {
    if (
      !isValidPrefix(prefix) ||
      (suffix !== undefined && !isValidPrefix(suffix))
    )
      throw new TypeError('topicsWithSubscribers needs a valid prefix/suffix');
    const pattern = `${CHANNEL_PREFIX}${prefix}:*${suffix ? `:${suffix}` : ''}`;
    let channels: string[];
    try {
      channels = (await withTimeout(
        this.redis.client.pubsub('CHANNELS', pattern) as Promise<string[]>,
        this.config.get('discoveryTimeoutMs'),
      )) as string[];
    } catch (error) {
      throw new RealtimeUnavailableError((error as Error).message);
    }
    // `*` also matches ':', so keep only exact routes: <prefix>:<id>[:<suffix>]
    const topics = channels
      .map((channel) => channel.slice(CHANNEL_PREFIX.length))
      .filter((topic) => {
        const parts = topic.split(':');
        return (
          parts[0] === prefix &&
          parts.length === (suffix ? 3 : 2) &&
          (!suffix || parts[2] === suffix) &&
          parseTopicShape(topic) !== null
        );
      })
      .sort();
    const limit = this.config.get('discoveryLimit');
    if (topics.length > limit) {
      this.logger.warn(
        `topicsWithSubscribers(${prefix}${suffix ? `, ${suffix}` : ''}) capped at ${limit} of ${topics.length} topics`,
      );
      return topics.slice(0, limit);
    }
    return topics;
  }

  async revoke(notice: RevocationNotice): Promise<void> {
    if (
      !isValidPrefix(notice.prefix) ||
      (notice.suffix !== undefined && !isValidPrefix(notice.suffix)) ||
      !parseTopicShape(`${notice.prefix}:${notice.id}`)
    )
      throw new TypeError('revoke needs a valid prefix, id and suffix');
    try {
      await withTimeout(
        this.redis.client.publish(CONTROL_CHANNEL, JSON.stringify(notice)),
        this.config.get('publishTimeoutMs'),
      );
    } catch (error) {
      throw new RealtimeUnavailableError((error as Error).message);
    }
  }
}
