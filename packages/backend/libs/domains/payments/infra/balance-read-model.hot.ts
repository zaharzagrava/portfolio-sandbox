import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type {
  BalanceReadModelStore,
  ReadModelLine,
} from '../domain/ledger-ports';

const TTL_SECONDS = 86_400;
const key = (accountId: string) => `ledger:balance:${accountId}`;

/**
 * Applies a field only when its version is higher (one atomic step), then refreshes the expiry.
 * Returns 0 applied, 1 stale (a higher version is stored), 2 duplicate (the same version is stored).
 */
const PUT_IF_NEWER = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current then
  local stored = tonumber(string.match(current, '^(%d+):'))
  if stored and stored >= tonumber(ARGV[2]) then
    if stored == tonumber(ARGV[2]) then return 2 end
    return 1
  end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 0
`;

/**
 * The hot copy of the balances (research R-8): Redis hash `ledger:balance:<accountId>`, one field per shard holding
 * `"<version>:<balanceMinor>:<projectedAtMs>:<currency>"`, expiring after 24 h on every write. A failure is the
 * caller's to handle: the projector retries (transient), the reader falls back to the durable copy.
 */
@Injectable()
export class RedisBalanceHot implements BalanceReadModelStore {
  constructor(private readonly redis: RedisService) {}

  async putIfNewer(
    line: ReadModelLine,
  ): Promise<'applied' | 'stale' | 'duplicate'> {
    const value = `${line.version}:${line.balanceMinor}:${line.projectedAt.getTime()}:${line.currency}`;
    const result = (await this.redis.client.eval(
      PUT_IF_NEWER,
      1,
      key(line.accountId),
      String(line.shard),
      String(line.version),
      value,
      String(TTL_SECONDS),
    )) as number;
    return result === 0 ? 'applied' : result === 1 ? 'stale' : 'duplicate';
  }

  async overwrite(line: ReadModelLine): Promise<void> {
    const value = `${line.version}:${line.balanceMinor}:${line.projectedAt.getTime()}:${line.currency}`;
    await this.redis.client.hset(
      key(line.accountId),
      String(line.shard),
      value,
    );
    await this.redis.client.expire(key(line.accountId), TTL_SECONDS);
  }

  async get(accountId: string): Promise<ReadModelLine[]> {
    const fields = await this.redis.client.hgetall(key(accountId));
    return Object.entries(fields).flatMap(([shard, value]) => {
      const [version, balance, projectedAt, currency] = value.split(':');
      const line = {
        accountId,
        shard: Number(shard),
        currency,
        balanceMinor: Number(balance),
        version: Number(version),
        projectedAt: new Date(Number(projectedAt)),
      };
      return Number.isSafeInteger(line.balanceMinor) &&
        Number.isSafeInteger(line.version) &&
        currency
        ? [line]
        : [];
    });
  }
}
