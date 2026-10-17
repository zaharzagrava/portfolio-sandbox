import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ShopFunctionsConfig } from '../application/shop-functions.config';
import {
  BREAKER_TRIAL_MS,
  breakerView,
  CLOSED_BREAKER,
  type Admission,
  type Breaker,
  type BreakerView,
} from '../domain/breaker';
import type { BreakerStore } from '../domain/ports';

const key = (functionId: string) => `shopfn:breaker:${functionId}`;
const HASH_TTL_SEC = 600;

/**
 * Hash fields: `ou` openUntil (0 = closed), `cnt`/`ws` failures in the current window and where it started, `tu` the
 * end of the running half-open trial, `lr`/`la` the last failure. Same rules as `domain/breaker.ts`, applied atomically.
 */
const ADMIT = `
local ou = tonumber(redis.call('HGET', KEYS[1], 'ou') or '0')
local now = tonumber(ARGV[1])
if ou == 0 then return 'ADMIT' end
if now < ou then return 'SKIP' end
local tu = tonumber(redis.call('HGET', KEYS[1], 'tu') or '0')
if tu > now then return 'SKIP' end
redis.call('HSET', KEYS[1], 'tu', now + tonumber(ARGV[2]))
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 'TRIAL'`;

const FAIL = `
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local open = tonumber(ARGV[4])
local ou = tonumber(redis.call('HGET', KEYS[1], 'ou') or '0')
redis.call('HSET', KEYS[1], 'lr', ARGV[5], 'la', now)
local opened = 0
if ou > 0 and now < ou then
  -- already open: only the last failure is recorded
elseif ou > 0 then
  redis.call('HSET', KEYS[1], 'ou', now + open, 'cnt', 0, 'ws', 0, 'tu', 0)
  opened = 1
else
  local ws = tonumber(redis.call('HGET', KEYS[1], 'ws') or '0')
  local cnt = tonumber(redis.call('HGET', KEYS[1], 'cnt') or '0')
  if ws == 0 or now - ws >= window then cnt = 1; ws = now else cnt = cnt + 1 end
  if cnt >= limit then
    redis.call('HSET', KEYS[1], 'ou', now + open, 'cnt', 0, 'ws', 0, 'tu', 0)
    opened = 1
  else
    redis.call('HSET', KEYS[1], 'cnt', cnt, 'ws', ws)
  end
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[6]))
return opened`;

const SUCCESS = `
local ou = tonumber(redis.call('HGET', KEYS[1], 'ou') or '0')
if ou > 0 and tonumber(ARGV[1]) >= ou then
  redis.call('HSET', KEYS[1], 'ou', 0, 'cnt', 0, 'ws', 0, 'tu', 0)
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 1`;

/** Circuit breaker state shared by every instance (S45 FR-030); losing it resets to CLOSED. */
@Injectable()
export class RedisBreakerStore implements BreakerStore {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ShopFunctionsConfig,
  ) {}

  async admit(functionId: string, now: number): Promise<Admission> {
    return (await this.redis.client.eval(
      ADMIT,
      1,
      key(functionId),
      now,
      BREAKER_TRIAL_MS,
      HASH_TTL_SEC,
    )) as Admission;
  }

  async recordFailure(functionId: string, now: number, reason: string) {
    const opened = await this.redis.client.eval(
      FAIL,
      1,
      key(functionId),
      now,
      this.config.breakerFailures,
      this.config.breakerWindowMs,
      this.config.breakerOpenMs,
      reason,
      HASH_TTL_SEC,
    );
    return { opened: Number(opened) === 1 };
  }

  async recordSuccess(functionId: string, now: number) {
    await this.redis.client.eval(
      SUCCESS,
      1,
      key(functionId),
      now,
      HASH_TTL_SEC,
    );
  }

  async view(functionId: string, now: number): Promise<BreakerView> {
    const raw = await this.redis.client.hgetall(key(functionId));
    const num = (v: string | undefined) => (v ? Number(v) : 0);
    const breaker: Breaker = raw.ou
      ? {
          ...CLOSED_BREAKER,
          openUntil: num(raw.ou) || null,
          lastFailure: raw.lr ? { reason: raw.lr, at: num(raw.la) } : null,
        }
      : {
          ...CLOSED_BREAKER,
          lastFailure: raw.lr ? { reason: raw.lr, at: num(raw.la) } : null,
        };
    return breakerView(breaker, now);
  }
}
