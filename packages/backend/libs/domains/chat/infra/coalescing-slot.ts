import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { CHAT_SETTINGS } from '../domain/chat-settings.token';
import type { ChatSettings } from '../domain/config';
import type { CoalescingSlot } from '../domain/ports';

const key = (recipientId: string, channelId: string) =>
  `chat:notified:{${recipientId}}:${channelId}`;
/** The key only collects garbage: whether a slot is still inside its window is decided from the stamped time. */
const KEY_TTL_S = 3_600;
/** A pending slot (taken, event not yet appended) holds the recipient's place this long: the crash window. */
const PENDING_MS = 30_000;

/** `p|c:<ms>:<token>`: pending or confirmed, when, by whom. Compare-and-set in one script each. */
const TAKE = `
local v = redis.call('GET', KEYS[1])
if v then
  local state, at = string.match(v, '^(%a):(%d+):')
  local window = (state == 'c') and tonumber(ARGV[2]) or tonumber(ARGV[3])
  if tonumber(ARGV[1]) - tonumber(at) < window then return 0 end
end
redis.call('SET', KEYS[1], 'p:' .. ARGV[1] .. ':' .. ARGV[4], 'EX', ARGV[5])
return 1`;
const CONFIRM = `
local v = redis.call('GET', KEYS[1])
if v and string.sub(v, -string.len(ARGV[2])) == ARGV[2] then
  redis.call('SET', KEYS[1], 'c:' .. ARGV[1] .. ':' .. ARGV[2], 'EX', ARGV[3])
  return 1
end
return 0`;
const RELEASE = `
local v = redis.call('GET', KEYS[1])
if v and string.sub(v, -string.len(ARGV[1])) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/**
 * The 5-minute window per (recipient, channel), stamped with the injected clock so a frozen clock moves it (AS-44).
 * Taking is atomic: of two checks racing for one window exactly one gets the slot.
 */
@Injectable()
export class RedisCoalescingSlot implements CoalescingSlot {
  constructor(
    private readonly redis: RedisService,
    @Inject(CHAT_SETTINGS) private readonly settings: ChatSettings,
  ) {}

  async take(recipientId: string, channelId: string, now: Date) {
    const token = randomUUID();
    const taken = await this.redis.client.eval(
      TAKE,
      1,
      key(recipientId, channelId),
      String(now.getTime()),
      String(this.settings.coalescingWindowS * 1000),
      String(PENDING_MS),
      token,
      String(KEY_TTL_S),
    );
    return taken === 1 ? { token } : null;
  }

  async confirm(
    recipientId: string,
    channelId: string,
    token: string,
    now: Date,
  ) {
    await this.redis.client.eval(
      CONFIRM,
      1,
      key(recipientId, channelId),
      String(now.getTime()),
      token,
      String(KEY_TTL_S),
    );
  }

  async release(recipientId: string, channelId: string, token: string) {
    await this.redis.client.eval(
      RELEASE,
      1,
      key(recipientId, channelId),
      token,
    );
  }
}
