import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { sleep } from '@app/common/core/backoff';

const RECORD_MAX = `
local current = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '-1')
if tonumber(ARGV[2]) > current then redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) end
return 1
`;

/**
 * Read-your-writes on top of eventually consistent read models (lesson
 * 06/02 §1): write APIs return the aggregate `version`; a read API given
 * `minVersion` waits briefly for the projection to catch up, and otherwise
 * falls back to the source of truth (or answers 202 "still processing").
 */
@Injectable()
export class ProjectionCheckpoints {
  constructor(private readonly redis: RedisService) {}

  private key(projector: string, aggregateType: string) {
    return `proj:ckpt:${projector}:${aggregateType}`;
  }

  async record(projector: string, events: EventEnvelope[]): Promise<void> {
    await Promise.all(
      events.map((e) =>
        this.redis.client.eval(RECORD_MAX, 1, this.key(projector, e.aggregateType), e.aggregateId, String(e.version)),
      ),
    );
  }

  async projectedVersion(projector: string, aggregateType: string, aggregateId: string): Promise<number> {
    const v = await this.redis.client.hget(this.key(projector, aggregateType), aggregateId);
    return v === null ? -1 : Number(v);
  }

  /** True once the read model reflects at least `minVersion`; false after `timeoutMs`. */
  async waitFor(projector: string, aggregateType: string, aggregateId: string, minVersion: number, timeoutMs = 500) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.projectedVersion(projector, aggregateType, aggregateId)) >= minVersion) return true;
      if (Date.now() >= deadline) return false;
      await sleep(25);
    }
  }
}
