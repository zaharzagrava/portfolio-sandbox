import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';

/**
 * Stores a read-model document as a Redis hash `{ v, doc }`, written only if
 * the incoming version is not older than the stored one. Atomic in Lua, so
 * two projector instances racing after a rebalance can't regress a document.
 */
const UPSERT_IF_NEWER = `
local current = tonumber(redis.call('HGET', KEYS[1], 'v') or '-1')
if tonumber(ARGV[1]) < current then return 0 end
redis.call('HSET', KEYS[1], 'v', ARGV[1], 'doc', ARGV[2])
if tonumber(ARGV[3]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return 1
`;

export interface RedisDocWrite {
  key: string;
  version: number;
  doc: unknown;
  ttlSec?: number;
}

@Injectable()
export class RedisDocSink {
  constructor(private readonly redis: RedisService) {}

  /** Pipelined (auto-pipelining): N writes ≈ one round trip. Returns how many were applied. */
  async upsertMany(writes: RedisDocWrite[]): Promise<number> {
    const results = await Promise.all(
      writes.map((w) =>
        this.redis.client.eval(
          UPSERT_IF_NEWER,
          1,
          w.key,
          String(w.version),
          JSON.stringify(w.doc),
          String(w.ttlSec ?? 0),
        ),
      ),
    );
    return results.filter((r) => r === 1).length;
  }

  async get<T>(key: string): Promise<{ version: number; doc: T } | null> {
    const [v, doc] = await this.redis.client.hmget(key, 'v', 'doc');
    return v === null || doc === null
      ? null
      : { version: Number(v), doc: JSON.parse(doc) as T };
  }
}
