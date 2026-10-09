import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { SinkCounts } from '../projector';

/**
 * Stores a read-model document as a Redis hash `{ v, doc, deleted }`, written only if the incoming version is
 * strictly greater than the stored one (S53 FR-032, FR-043). Atomic in Lua, so two projector instances racing after a
 * rebalance can't regress a document. Answers 1 applied, 2 duplicate (equal version), 3 stale (older version).
 * A delete is a write: it keeps the version as a tombstone, so a late older write cannot resurrect the document.
 */
const UPSERT_IF_NEWER = `
local stored = redis.call('HGET', KEYS[1], 'v')
local incoming = tonumber(ARGV[1])
if stored then
  local current = tonumber(stored)
  if incoming == current then return 2 end
  if incoming < current then return 3 end
end
redis.call('HSET', KEYS[1], 'v', ARGV[1], 'doc', ARGV[2], 'deleted', ARGV[4])
if tonumber(ARGV[3]) > 0 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
return 1
`;

export interface RedisDocWrite {
  key: string;
  version: number;
  doc: unknown;
  ttlSec?: number;
}

export interface RedisDocDelete {
  key: string;
  /** The aggregate version of the delete: it must keep rising like any other event. */
  version: number;
  /** How long the tombstone is kept (default: forever, the version is the point). */
  ttlSec?: number;
}

export interface StoredDoc<T> {
  version: number;
  doc: T | null;
  deleted: boolean;
}

@Injectable()
export class RedisDocSink {
  constructor(private readonly redis: RedisService) {}

  /** Pipelined (auto-pipelining): N writes ≈ one round trip. Counts how each write ended. */
  async upsertMany(writes: RedisDocWrite[]): Promise<SinkCounts> {
    return this.run(
      writes.map((w) => ({
        key: w.key,
        version: w.version,
        doc: JSON.stringify(w.doc),
        ttlSec: w.ttlSec ?? 0,
        deleted: '0',
      })),
    );
  }

  /** Deletes as versioned tombstones `{ v, deleted: true }`: the version is kept, the document is dropped. */
  async deleteMany(deletes: RedisDocDelete[]): Promise<SinkCounts> {
    return this.run(
      deletes.map((d) => ({
        key: d.key,
        version: d.version,
        doc: 'null',
        ttlSec: d.ttlSec ?? 0,
        deleted: '1',
      })),
    );
  }

  async get<T>(key: string): Promise<StoredDoc<T> | null> {
    const [v, doc, deleted] = await this.redis.client.hmget(
      key,
      'v',
      'doc',
      'deleted',
    );
    if (v === null) return null;
    return {
      version: Number(v),
      doc: doc === null || doc === 'null' ? null : (JSON.parse(doc) as T),
      deleted: deleted === '1',
    };
  }

  private async run(
    writes: {
      key: string;
      version: number;
      doc: string;
      ttlSec: number;
      deleted: string;
    }[],
  ): Promise<SinkCounts> {
    const results = await Promise.all(
      writes.map((w) =>
        this.redis.client.eval(
          UPSERT_IF_NEWER,
          1,
          w.key,
          String(w.version),
          w.doc,
          String(w.ttlSec),
          w.deleted,
        ),
      ),
    );
    return {
      applied: results.filter((r) => r === 1).length,
      duplicate: results.filter((r) => r === 2).length,
      stale: results.filter((r) => r === 3).length,
    };
  }
}
