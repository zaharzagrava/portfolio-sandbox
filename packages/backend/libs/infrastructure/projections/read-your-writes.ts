import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { coalesceLatest } from './coalesce';

/** Raises the stored version, never lowers it, and (re)starts the expiry either way. */
const RECORD_MAX = `
local current = tonumber(redis.call('GET', KEYS[1]) or '-1')
if tonumber(ARGV[1]) > current then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
else
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 1
`;

/**
 * The checkpoint of a read model: the highest `aggregateVersion` of an aggregate that a consumer has handled
 * (S53 FR-046). One key per consumer and aggregate, `ryw:{consumer}:{aggregateType}:{aggregateId}`, written by the
 * framework after the sink write for every handled, coalesced and skipped event, only ever rising, expiring after
 * `ryw_checkpoint_ttl_s` (24 h) so memory stays bounded.
 */
@Injectable()
export class ProjectionCheckpoints {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ApiConfigService,
  ) {}

  private key(consumer: string, aggregateType: string, aggregateId: string) {
    return `ryw:${consumer}:${aggregateType}:${aggregateId}`;
  }

  async record(consumer: string, events: EventEnvelope[]): Promise<void> {
    const ttl = String(this.config.get('ryw_checkpoint_ttl_s'));
    await Promise.all(
      coalesceLatest(events).map((e) =>
        this.redis.client.eval(
          RECORD_MAX,
          1,
          this.key(consumer, e.aggregateType, e.aggregateId),
          String(e.aggregateVersion),
          ttl,
        ),
      ),
    );
  }

  /** The highest handled version, or -1 when nothing is recorded (never handled, or expired). */
  async projectedVersion(
    consumer: string,
    aggregateType: string,
    aggregateId: string,
  ): Promise<number> {
    const v = await this.redis.client.get(
      this.key(consumer, aggregateType, aggregateId),
    );
    return v === null ? -1 : Number(v);
  }
}
