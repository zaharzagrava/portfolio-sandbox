import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { JobLock, ProjectionProgress } from '../domain/ledger-ports';

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/**
 * A Redis lock that keeps a scheduled job to one runner at a time across replicas (S14 FR-044). It saves the double
 * work; correctness never depends on it (every job is idempotent), so a Redis outage lets the job run anyway.
 */
@Injectable()
export class RedisJobLock implements JobLock {
  constructor(private readonly redis: RedisService) {}

  async acquire(name: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    try {
      const ok = await this.redis.client.set(
        `ledger:job-lock:${name}`,
        token,
        'PX',
        ttlMs,
        'NX',
      );
      return ok === 'OK' ? token : null;
    } catch {
      return token; // the lock store is down: run, the job is idempotent
    }
  }

  async release(name: string, token: string): Promise<void> {
    try {
      await this.redis.client.eval(
        RELEASE,
        1,
        `ledger:job-lock:${name}`,
        token,
      );
    } catch {
      /* the lock expires on its own */
    }
  }
}

const MAX_LUA = `
local current = redis.call('GET', KEYS[1])
if (not current) or tonumber(current) < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], ARGV[1])
  return 1
end
return 0
`;

const PROGRESS_KEY = 'ledger:projection:lastPostedAt';

/** The newest posting time the projector applied, in Redis (the projector and the checker run in different apps). */
@Injectable()
export class RedisProjectionProgress implements ProjectionProgress {
  constructor(private readonly redis: RedisService) {}

  async record(postedAt: Date): Promise<void> {
    await this.redis.client.eval(
      MAX_LUA,
      1,
      PROGRESS_KEY,
      String(postedAt.getTime()),
    );
  }

  async last(): Promise<Date | null> {
    const value = await this.redis.client.get(PROGRESS_KEY);
    return value ? new Date(Number(value)) : null;
  }
}
