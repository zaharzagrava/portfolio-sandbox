import { Inject, Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { EntitlementsService } from '@app/domains/billing';
import {
  ASSISTANT_CLOCK,
  type Clock,
  type QuotaCounter,
} from '../domain/assistant-ports';

const counterKey = (u: string, month: string) =>
  `assistant:quota:{${u}}:${month}`;
const callsKey = (u: string, month: string) =>
  `assistant:quota-calls:{${u}}:${month}`;
/** The counter of a month outlives it by a week, then expires on its own. */
const COUNTER_TTL_MS = 38 * 86_400_000;

/** KEYS: counter, charged call ids. ARGV: call id, tokens, ttl ms. Returns the new total (idempotent per call id). */
const CHARGE = `
local added = redis.call('SADD', KEYS[2], ARGV[1])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
if added == 1 and tonumber(ARGV[2]) > 0 then
  redis.call('INCRBY', KEYS[1], ARGV[2])
end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return tonumber(redis.call('GET', KEYS[1]) or '0')`;

/** The month counter could not be read or seeded (billing unreadable): admission fails closed. */
export class QuotaUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('allowance counter unavailable', { cause });
    this.name = 'QuotaUnavailableError';
  }
}

/**
 * Month counter of the assistant's token allowance (S46 FR-025/FR-026). The counter is admission control; billing is the
 * system of record. A missing counter is seeded once from billing's exact usage (`checkQuota`), never from zero.
 */
@Injectable()
export class RedisQuotaCounter implements QuotaCounter {
  constructor(
    private readonly redis: RedisService,
    private readonly entitlements: EntitlementsService,
    @Inject(ASSISTANT_CLOCK) private readonly clock: Clock,
  ) {}

  async used(userId: string, month: string): Promise<number> {
    const key = counterKey(userId, month);
    const current = await this.redis.client.get(key);
    if (current !== null) return Number(current);
    let seed: number;
    try {
      const status = await this.entitlements.checkQuota(
        'USER',
        userId,
        'assistantTokensPerMonth',
        this.clock.now(),
      );
      seed = status.used;
    } catch (error) {
      throw new QuotaUnavailableError(error);
    }
    // Two sends racing on a cold counter both seed; the first write wins and both read it.
    await this.redis.client.set(key, String(seed), 'PX', COUNTER_TTL_MS, 'NX');
    return Number((await this.redis.client.get(key)) ?? seed);
  }

  async charge(
    userId: string,
    month: string,
    callId: string,
    billableTokens: number,
  ): Promise<number> {
    const total = await this.redis.client.eval(
      CHARGE,
      2,
      counterKey(userId, month),
      callsKey(userId, month),
      callId,
      String(Math.max(0, Math.trunc(billableTokens))),
      String(COUNTER_TTL_MS),
    );
    return Number(total);
  }
}
