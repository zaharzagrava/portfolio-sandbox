import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { RealtimeConfig } from '../config/realtime.config';
import { CONTROL_CHANNEL } from '../keys';
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
  constructor(
    private readonly redis: RedisService,
    private readonly config: RealtimeConfig,
  ) {}

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
