import { RedisService } from '@app/infrastructure/redis/redis.service';

/** Atomically takes the whole pending hash (HGETALL + DEL) so increments arriving during a flush go to the next one. */
const DRAIN = `
local entries = redis.call('HGETALL', KEYS[1])
redis.call('DEL', KEYS[1])
return entries
`;

/**
 * Write-behind counters (README #22): hot, low-value increments (product
 * views, likes) go to a Redis hash with HINCRBY - O(1), no DB write per
 * event - and a periodic job drains the hash into the database in one batch.
 * 10k views/s on one product = 1 row update per flush instead of 10k row
 * locks per second. Trade-off: up to one flush interval of counts can be lost
 * if Redis loses data (acceptable for analytics-grade counters, never money).
 */
export class WriteBehindCounter {
  private readonly key: string;

  constructor(
    private readonly redis: RedisService,
    name: string,
  ) {
    this.key = `wb:{${name}}`;
  }

  async increment(member: string, by = 1): Promise<void> {
    await this.redis.client.hincrby(this.key, member, by);
  }

  /** Returns the drained deltas; the caller persists them (and re-adds on failure). */
  async drain(): Promise<Map<string, number>> {
    const flat = (await this.redis.client.eval(DRAIN, 1, this.key)) as string[];
    const deltas = new Map<string, number>();
    for (let i = 0; i < flat.length; i += 2) deltas.set(flat[i], Number(flat[i + 1]));
    return deltas;
  }

  /** Puts deltas back after a failed flush so counts aren't lost. */
  async restore(deltas: Map<string, number>): Promise<void> {
    const pipeline = this.redis.client.pipeline();
    for (const [member, by] of deltas) pipeline.hincrby(this.key, member, by);
    await pipeline.exec();
  }
}
