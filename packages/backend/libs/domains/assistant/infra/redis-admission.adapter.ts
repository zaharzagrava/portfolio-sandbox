import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type {
  AdmissionStore,
  IdempotencyClaim,
  IdempotencyRecord,
} from '../domain/assistant-ports';

const lockKey = (u: string, c: string) => `assistant:lock:{${u}}:${c}`;
const slotsKey = (u: string) => `assistant:slots:{${u}}`;
const idemKey = (u: string, k: string) => `assistant:idem:{${u}}:${k}`;
const cooldownKey = (model: string) => `assistant:cooldown:${model}`;

/** Deletes the key only while it still holds the caller's value (a reply never frees a lock another reply took). */
const RELEASE_IF_OWNER = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/** Releases an idempotency record only while it still belongs to the same message id. */
const RELEASE_IDEMPOTENCY = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
if record.messageId == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/**
 * Takes one slot of the user's cap atomically: expired members go first, then the new one is added only below the cap.
 * KEYS: slots. ARGV: member, now, expiresAt, cap.
 */
const ACQUIRE_SLOT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) - tonumber(ARGV[2]) + 1000)
return 1`;

/**
 * Redis side of admission (data-model.md "Admission state"): the idempotency record, the reply lock, the per-user slots
 * and the fleet-wide model cooldown. Every key carries the user, so one user's keys never meet another's.
 */
@Injectable()
export class RedisAdmissionAdapter implements AdmissionStore {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ApiConfigService,
  ) {}

  async claimIdempotency(
    userId: string,
    key: string,
    record: IdempotencyRecord,
  ): Promise<IdempotencyClaim> {
    const redisKey = idemKey(userId, key);
    const claimed = await this.redis.client.set(
      redisKey,
      JSON.stringify(record),
      'PX',
      this.config.get('assistant_replay_window_ms'),
      'NX',
    );
    if (claimed === 'OK') return { kind: 'claimed' };
    const raw = await this.redis.client.get(redisKey);
    // Expired between the two calls: try once more as a fresh claim.
    if (!raw) return this.claimIdempotency(userId, key, record);
    return { kind: 'existing', record: JSON.parse(raw) as IdempotencyRecord };
  }

  async releaseIdempotency(
    userId: string,
    key: string,
    messageId: string,
  ): Promise<void> {
    await this.redis.client.eval(
      RELEASE_IDEMPOTENCY,
      1,
      idemKey(userId, key),
      messageId,
    );
  }

  async acquireLock(
    userId: string,
    conversationId: string,
    messageId: string,
    ttlMs: number,
  ): Promise<boolean> {
    const ok = await this.redis.client.set(
      lockKey(userId, conversationId),
      messageId,
      'PX',
      ttlMs,
      'NX',
    );
    return ok === 'OK';
  }

  async releaseLock(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    await this.redis.client.eval(
      RELEASE_IF_OWNER,
      1,
      lockKey(userId, conversationId),
      messageId,
    );
  }

  lockHolder(userId: string, conversationId: string): Promise<string | null> {
    return this.redis.client.get(lockKey(userId, conversationId));
  }

  async acquireSlot(
    userId: string,
    messageId: string,
    cap: number,
    ttlMs: number,
  ): Promise<boolean> {
    const now = Date.now();
    const taken = await this.redis.client.eval(
      ACQUIRE_SLOT,
      1,
      slotsKey(userId),
      messageId,
      String(now),
      String(now + ttlMs),
      String(cap),
    );
    return taken === 1;
  }

  async releaseSlot(userId: string, messageId: string): Promise<void> {
    await this.redis.client.zrem(slotsKey(userId), messageId);
  }

  async slotMembers(userId: string): Promise<string[]> {
    return this.redis.client.zrangebyscore(
      slotsKey(userId),
      Date.now(),
      '+inf',
    );
  }

  async setCooldown(model: string, durationMs: number): Promise<void> {
    await this.redis.client.set(
      cooldownKey(model),
      '1',
      'PX',
      Math.max(1, Math.round(durationMs)),
    );
  }

  async cooldownRemainingMs(model: string): Promise<number> {
    const ttl = await this.redis.client.pttl(cooldownKey(model));
    return ttl > 0 ? ttl : 0;
  }
}
