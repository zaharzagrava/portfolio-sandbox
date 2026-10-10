import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { BffSettings } from '../bff-config';
import { SessionCipher } from './session-crypto';
import type { PendingMfa, SessionRecord } from './session-record';

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

export const sessionKey = (cookie: string) => `bff:sess:${sha256(cookie)}`;
export const mfaKey = (cookie: string) => `bff:mfa:${sha256(cookie)}`;
export const mfaLockKey = (cookie: string) => `bff:mfa-lock:${sha256(cookie)}`;
export const refreshLockKey = (cookie: string) =>
  `bff:refresh:${sha256(cookie)}`;

/** Replace the value only if the stored version is the expected one (a slow writer never overwrites a newer record). */
const COMPARE_AND_SET = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local v = tonumber(string.match(cur, '^(%d+)%.'))
if v ~= tonumber(ARGV[1]) then return -1 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1`;
const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

export type CasResult = 'ok' | 'conflict' | 'gone';

/**
 * Redis adapter of the session state (S48 data-model): sessions, pending second factors and the short locks. Every key
 * carries a TTL (III.9), none is read with `KEYS`. Values are encrypted; the key is the hash of the cookie value, so a
 * store leak yields neither cookies nor tokens. Errors propagate: callers decide fail-closed vs. ignore.
 */
@Injectable()
export class SessionStore {
  private readonly cipher: SessionCipher;

  constructor(
    private readonly redis: RedisService,
    settings: BffSettings,
  ) {
    this.cipher = new SessionCipher(settings.sessionKeys);
  }

  private seal(
    key: string,
    version: number | undefined,
    value: unknown,
  ): string {
    const sealed = this.cipher.encrypt(JSON.stringify(value), key);
    return version === undefined ? sealed : `${version}.${sealed}`;
  }

  private open<T>(
    key: string,
    stored: string,
    versioned: boolean,
  ): T | undefined {
    const sealed = versioned ? stored.slice(stored.indexOf('.') + 1) : stored;
    const plain = this.cipher.decrypt(sealed, key);
    if (plain === undefined) return undefined;
    try {
      return JSON.parse(plain) as T;
    } catch {
      return undefined;
    }
  }

  async create(
    cookie: string,
    record: SessionRecord,
    ttlMs: number,
  ): Promise<void> {
    const key = sessionKey(cookie);
    const stored = await this.redis.client.set(
      key,
      this.seal(key, record.tokenVersion, record),
      'PX',
      Math.max(1, Math.floor(ttlMs)),
      'NX',
    );
    if (stored !== 'OK') throw new Error('session key collision');
  }

  async get(cookie: string): Promise<SessionRecord | undefined> {
    const key = sessionKey(cookie);
    const stored = await this.redis.client.get(key);
    return stored ? this.open<SessionRecord>(key, stored, true) : undefined;
  }

  /** Writes `record` if the stored version is `expectedVersion`. `record.tokenVersion` is the version it carries. */
  async compareAndSet(
    cookie: string,
    expectedVersion: number,
    record: SessionRecord,
    ttlMs: number,
  ): Promise<CasResult> {
    const key = sessionKey(cookie);
    const result = (await this.redis.client.eval(
      COMPARE_AND_SET,
      1,
      key,
      String(expectedVersion),
      this.seal(key, record.tokenVersion, record),
      String(Math.max(1, Math.floor(ttlMs))),
    )) as number;
    return result === 1 ? 'ok' : result === 0 ? 'gone' : 'conflict';
  }

  async delete(cookie: string): Promise<void> {
    await this.redis.client.del(sessionKey(cookie));
  }

  async createPending(
    cookie: string,
    pending: PendingMfa,
    ttlMs: number,
  ): Promise<void> {
    const key = mfaKey(cookie);
    await this.redis.client.set(
      key,
      this.seal(key, undefined, pending),
      'PX',
      Math.max(1, Math.floor(ttlMs)),
    );
  }

  async getPending(cookie: string): Promise<PendingMfa | undefined> {
    const key = mfaKey(cookie);
    const stored = await this.redis.client.get(key);
    return stored ? this.open<PendingMfa>(key, stored, false) : undefined;
  }

  async deletePending(cookie: string): Promise<void> {
    await this.redis.client.del(mfaKey(cookie));
  }

  /** `SET NX PX`; the returned owner token is needed to release. `null` when someone else holds it. */
  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    const owner = randomUUID();
    const ok = await this.redis.client.set(key, owner, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? owner : null;
  }

  async releaseLock(key: string, owner: string): Promise<void> {
    await this.redis.client.eval(RELEASE_LOCK, 1, key, owner);
  }
}
