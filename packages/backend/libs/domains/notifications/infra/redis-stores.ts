import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { Channel } from '../domain/catalog';
import type {
  CapDecision,
  CapStore,
  ClaimStore,
  CounterStore,
  DeadLetterRecord,
  DeadLetterSink,
  DedupeStore,
  HeldDelivery,
  HeldDeliveryStore,
  OtpStore,
  VersionGuardStore,
} from '../domain/ports';
import { REDIS_TIMEOUT_MS, withTimeout } from './with-timeout';

/**
 * Redis keys of notifications (data-model.md "Redis keys"; prefix `notif:`, every key has a TTL except the dirty set,
 * which is swept every 5 minutes). Keys that hold one user's state carry the user id in a hash tag so a script that
 * touches two of them stays on one slot. The instance must not use an `allkeys-*` eviction policy (III.9). Every call
 * has a 200 ms timeout; the caller decides what a failure means (marketing caps fail closed).
 */
const P = 'notif:';
const DAY_S = 86_400;

export const redisKeys = {
  done: (identity: string) => `${P}done:${identity}`,
  version: (family: string, aggregateId: string) =>
    `${P}ver:${family}:${aggregateId}`,
  cap: (userId: string, channel: Channel) => `${P}cap:{${userId}}:${channel}`,
  capDecision: (userId: string, deliveryId: string) =>
    `${P}cap:dec:{${userId}}:${deliveryId}`,
  unread: (userId: string) => `${P}unread:{${userId}}`,
  unreadDirty: `${P}unread:dirty`,
  held: (deliveryId: string) => `${P}held:${deliveryId}`,
  claim: (deliveryId: string) => `${P}claim:${deliveryId}`,
  sent: (deliveryId: string) => `${P}sent:${deliveryId}`,
  otp: (userId: string) => `${P}otp:{${userId}}`,
  otpAttempts: (userId: string) => `${P}otp:att:{${userId}}`,
  otpLock: (userId: string) => `${P}otp:lock:{${userId}}`,
  deadLetters: `${P}dead:letters`,
} as const;

const UNREAD_TTL_S = 400 * DAY_S;

/** The shared base: one place for the timeout. `@Injectable()` so subclasses inherit the constructor's injection metadata. */
@Injectable()
abstract class RedisBacked {
  constructor(protected readonly redis: RedisService) {}

  protected call<T>(what: string, command: Promise<T>): Promise<T> {
    return withTimeout(command, REDIS_TIMEOUT_MS, `redis ${what}`);
  }
}

@Injectable()
export class RedisDedupeStore extends RedisBacked implements DedupeStore {
  async isDone(identity: string): Promise<boolean> {
    return (
      (await this.call(
        'done',
        this.redis.client.exists(redisKeys.done(identity)),
      )) === 1
    );
  }

  async markDone(identity: string): Promise<void> {
    await this.call(
      'done',
      this.redis.client.set(redisKeys.done(identity), '1', 'EX', 7 * DAY_S),
    );
  }
}

const VERSION_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if cur and tonumber(cur) > tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1`;

@Injectable()
export class RedisVersionGuardStore
  extends RedisBacked
  implements VersionGuardStore
{
  async admit(
    family: string,
    aggregateId: string,
    version: number,
  ): Promise<boolean> {
    const admitted = await this.call(
      'version',
      this.redis.client.eval(
        VERSION_SCRIPT,
        1,
        redisKeys.version(family, aggregateId),
        String(version),
        String(7 * DAY_S),
      ),
    );
    return admitted === 1;
  }
}

// KEYS: window zset, decision. ARGV: deliveryId, nowMs, windowMs, limit, decisionTtlS.
// The first decision for a delivery id is final; otherwise admit while fewer than `limit` admits sit in the window.
const CAP_SCRIPT = `
local decided = redis.call('GET', KEYS[2])
if decided then return decided end
local now = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local verdict = 'reject'
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[4]) then
  redis.call('ZADD', KEYS[1], now, ARGV[1])
  redis.call('PEXPIRE', KEYS[1], window + 3600000)
  verdict = 'admit'
end
redis.call('SET', KEYS[2], verdict, 'EX', ARGV[5])
return verdict`;

@Injectable()
export class RedisCapStore extends RedisBacked implements CapStore {
  async admit(input: {
    userId: string;
    channel: Channel;
    deliveryId: string;
    limit: number;
    windowMs: number;
    now: Date;
  }): Promise<CapDecision> {
    const verdict = await this.call(
      'cap',
      this.redis.client.eval(
        CAP_SCRIPT,
        2,
        redisKeys.cap(input.userId, input.channel),
        redisKeys.capDecision(input.userId, input.deliveryId),
        input.deliveryId,
        String(input.now.getTime()),
        String(input.windowMs),
        String(input.limit),
        String(7 * DAY_S),
      ),
    );
    return verdict === 'admit' ? 'admit' : 'reject';
  }
}

@Injectable()
export class RedisHeldDeliveryStore
  extends RedisBacked
  implements HeldDeliveryStore
{
  async put(
    deliveryId: string,
    held: HeldDelivery,
    ttlSeconds: number,
  ): Promise<void> {
    await this.call(
      'held',
      this.redis.client.set(
        redisKeys.held(deliveryId),
        JSON.stringify({
          ...held,
          staleAt: held.staleAt.toISOString(),
          wakeAt: held.wakeAt.toISOString(),
        }),
        'EX',
        ttlSeconds,
      ),
    );
  }

  async get(deliveryId: string): Promise<HeldDelivery | null> {
    const raw = await this.call(
      'held',
      this.redis.client.get(redisKeys.held(deliveryId)),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Omit<
      HeldDelivery,
      'staleAt' | 'wakeAt'
    > & {
      staleAt: string;
      wakeAt: string;
    };
    return {
      ...parsed,
      staleAt: new Date(parsed.staleAt),
      wakeAt: new Date(parsed.wakeAt),
    };
  }

  async delete(deliveryId: string): Promise<void> {
    await this.call('held', this.redis.client.del(redisKeys.held(deliveryId)));
  }
}

// The counter is derived data: an absent key means "unknown, rebuild from the inbox", so increments never create it.
const INCREMENT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('INCR', KEYS[1]) end
return -1`;
const DECREMENT_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local v = redis.call('DECRBY', KEYS[1], ARGV[1])
if v < 0 then redis.call('SET', KEYS[1], 0, 'EX', ARGV[2]); return 0 end
return v`;

@Injectable()
export class RedisCounterStore extends RedisBacked implements CounterStore {
  async get(userId: string): Promise<number | null> {
    const raw = await this.call(
      'unread',
      this.redis.client.get(redisKeys.unread(userId)),
    );
    return raw === null ? null : Math.max(0, Number(raw));
  }

  async increment(userId: string): Promise<void> {
    await this.call(
      'unread',
      this.redis.client.eval(INCREMENT_SCRIPT, 1, redisKeys.unread(userId)),
    );
  }

  async decrement(userId: string, by: number): Promise<void> {
    await this.call(
      'unread',
      this.redis.client.eval(
        DECREMENT_SCRIPT,
        1,
        redisKeys.unread(userId),
        String(by),
        String(UNREAD_TTL_S),
      ),
    );
  }

  async set(userId: string, value: number): Promise<void> {
    await this.call(
      'unread',
      this.redis.client.set(
        redisKeys.unread(userId),
        String(value),
        'EX',
        UNREAD_TTL_S,
      ),
    );
  }

  async markDirty(userId: string, at: Date): Promise<void> {
    // NX: keep the first mark, so the sweep sees how long a user has been dirty.
    await this.call(
      'unread dirty',
      this.redis.client.zadd(redisKeys.unreadDirty, 'NX', at.getTime(), userId),
    );
  }

  async clearDirty(userId: string): Promise<void> {
    await this.call(
      'unread dirty',
      this.redis.client.zrem(redisKeys.unreadDirty, userId),
    );
  }

  async dirtyBefore(before: Date, limit: number): Promise<string[]> {
    return this.call(
      'unread dirty',
      this.redis.client.zrangebyscore(
        redisKeys.unreadDirty,
        '-inf',
        before.getTime(),
        'LIMIT',
        0,
        limit,
      ),
    );
  }
}

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

@Injectable()
export class RedisClaimStore extends RedisBacked implements ClaimStore {
  async claim(
    deliveryId: string,
    workerId: string,
    ttlMs: number,
  ): Promise<boolean> {
    const won = await this.call(
      'claim',
      this.redis.client.set(
        redisKeys.claim(deliveryId),
        workerId,
        'PX',
        ttlMs,
        'NX',
      ),
    );
    return won === 'OK';
  }

  async release(deliveryId: string, workerId: string): Promise<void> {
    await this.call(
      'claim',
      this.redis.client.eval(
        RELEASE_SCRIPT,
        1,
        redisKeys.claim(deliveryId),
        workerId,
      ),
    );
  }

  sentMarker(deliveryId: string): Promise<string | null> {
    return this.call('sent', this.redis.client.get(redisKeys.sent(deliveryId)));
  }

  async markSent(deliveryId: string, providerMessageId: string): Promise<void> {
    await this.call(
      'sent',
      this.redis.client.set(
        redisKeys.sent(deliveryId),
        providerMessageId,
        'EX',
        7 * DAY_S,
      ),
    );
  }
}

@Injectable()
export class RedisOtpStore extends RedisBacked implements OtpStore {
  async put(
    userId: string,
    codeMac: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.call(
      'otp',
      this.redis.client
        .multi()
        .set(redisKeys.otp(userId), codeMac, 'EX', ttlSeconds)
        .del(redisKeys.otpAttempts(userId))
        .exec(),
    );
  }

  get(userId: string): Promise<string | null> {
    return this.call('otp', this.redis.client.get(redisKeys.otp(userId)));
  }

  async failAttempt(userId: string, ttlSeconds: number): Promise<number> {
    const key = redisKeys.otpAttempts(userId);
    const count = await this.call('otp', this.redis.client.incr(key));
    if (count === 1)
      await this.call('otp', this.redis.client.expire(key, ttlSeconds));
    return count;
  }

  async lock(userId: string, ttlSeconds: number): Promise<void> {
    await this.call(
      'otp',
      this.redis.client
        .multi()
        .set(redisKeys.otpLock(userId), '1', 'EX', ttlSeconds)
        .del(redisKeys.otp(userId), redisKeys.otpAttempts(userId))
        .exec(),
    );
  }

  async lockedFor(userId: string): Promise<number> {
    const ms = await this.call(
      'otp',
      this.redis.client.pttl(redisKeys.otpLock(userId)),
    );
    return ms > 0 ? Math.ceil(ms / 1_000) : 0;
  }

  async clear(userId: string): Promise<void> {
    await this.call(
      'otp',
      this.redis.client.del(
        redisKeys.otp(userId),
        redisKeys.otpAttempts(userId),
      ),
    );
  }
}

const DEAD_LETTER_KEEP = 1_000;
const DEAD_LETTER_TTL_S = 30 * DAY_S;

/**
 * `DEAD_LETTER_SINK`: the newest 1,000 messages S28 gave up on, kept 30 days. A record names the message and the reason
 * and nothing else: never a payload, address, body or token (FR-004, FR-014). The source topic holds the original for
 * ordinary events; a single-consumer message with a secret has no copy anywhere else.
 */
@Injectable()
export class RedisDeadLetterSink extends RedisBacked implements DeadLetterSink {
  async record(letter: DeadLetterRecord): Promise<void> {
    await this.call(
      'dead letters',
      this.redis.client
        .multi()
        .lpush(
          redisKeys.deadLetters,
          JSON.stringify({ ...letter, at: letter.at.toISOString() }),
        )
        .ltrim(redisKeys.deadLetters, 0, DEAD_LETTER_KEEP - 1)
        .expire(redisKeys.deadLetters, DEAD_LETTER_TTL_S)
        .exec(),
    );
  }

  async recent(limit: number): Promise<DeadLetterRecord[]> {
    const raw = await this.call(
      'dead letters',
      this.redis.client.lrange(redisKeys.deadLetters, 0, limit - 1),
    );
    return raw.map((entry) => {
      const parsed = JSON.parse(entry) as Omit<DeadLetterRecord, 'at'> & {
        at: string;
      };
      return { ...parsed, at: new Date(parsed.at) };
    });
  }
}
