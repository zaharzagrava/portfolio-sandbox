import { Injectable } from '@nestjs/common';
import type { FlagRulesetSnapshot } from '@marketplace-sandbox/contracts';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { RulesetPublisher } from '../domain/ports';
import {
  FLAGS_TOPIC,
  RULESET_KEY,
  RULESET_PUSH_TYPE,
  RULESET_TTL_SECONDS,
} from './redis-keys';

/**
 * Replace the cached snapshot only with a NEWER one (two writers publishing out of order cannot move it backwards); a
 * value that is not a snapshot is always replaced. The key always has a TTL.
 */
const SET_IF_NEWER = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local ok, decoded = pcall(cjson.decode, cur)
  if ok and type(decoded) == 'table' and tonumber(decoded['version']) and tonumber(decoded['version']) >= tonumber(ARGV[2]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))
return 1`;

/** Redis adapter of `RulesetPublisher`: snapshot in `flags:ruleset` (TTL 1 h), then the bare version on the `flags` channel. */
@Injectable()
export class RedisRulesetPublisher implements RulesetPublisher {
  constructor(
    private readonly redis: RedisService,
    private readonly realtime: RealtimePublisher,
  ) {}

  async publish(snapshot: FlagRulesetSnapshot): Promise<void> {
    const written = await this.redis.client.eval(
      SET_IF_NEWER,
      1,
      RULESET_KEY,
      JSON.stringify(snapshot),
      snapshot.version,
      RULESET_TTL_SECONDS,
    );
    if (written !== 1) return;
    const pushed = await this.realtime.publish(
      FLAGS_TOPIC,
      RULESET_PUSH_TYPE,
      { version: snapshot.version },
      { replay: false },
    );
    if (!pushed.published) throw new Error('ruleset push was not published');
  }

  async cachedVersion(): Promise<number | null> {
    const raw = await this.redis.client.get(RULESET_KEY);
    if (raw === null) return null;
    try {
      const version = (JSON.parse(raw) as { version?: unknown }).version;
      return typeof version === 'number' && Number.isInteger(version)
        ? version
        : null;
    } catch {
      return null;
    }
  }
}
