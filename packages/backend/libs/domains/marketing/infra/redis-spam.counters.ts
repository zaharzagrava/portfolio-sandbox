import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { SpamCounterKeys, SpamCounters } from '../domain/ads-ports';
import type { SpamCounts } from '../domain/spam-filter';
import { STORE_TIMEOUT_MS } from '../domain/ads-constants';
import { withDeadline } from './ads-timeout';

/** `INCR`, and the expiry only on the first write of the window: a later click never extends it (G16). One key per script. */
const INCR_WINDOW = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return n`;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `YYYYMMDDHHmm` and `YYYYMMDDHH` of the fixed UTC minute and hour the click falls in. */
const minuteKey = (at: Date) =>
  `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`;
const hourKey = (at: Date) => minuteKey(at).slice(0, 10);

/**
 * Exact counters of the spam rules (FR-027): address per UTC minute (any campaign), address per campaign per UTC hour,
 * viewer per campaign per UTC hour. Each is one atomic script on one key (valid on a clustered Redis), so 25 concurrent
 * clicks get counts 1..25 and exactly 20 are within the threshold. The three share the 100 ms budget. Keys hold hashes,
 * never a raw address; every key has a TTL. Owner: `marketing` (S36).
 */
@Injectable()
export class RedisSpamCounters implements SpamCounters {
  constructor(private readonly redis: RedisService) {}

  async record(keys: SpamCounterKeys): Promise<SpamCounts> {
    const minute = minuteKey(keys.at);
    const hour = hourKey(keys.at);
    const incr = (key: string, ttl: number): Promise<number> =>
      this.redis.client.eval(INCR_WINDOW, 1, key, ttl) as Promise<number>;
    const [addressMinute, addressHour, viewerHour] = await withDeadline(
      'spam-counters',
      STORE_TIMEOUT_MS,
      () =>
        Promise.all([
          incr(`adspam:ip:${keys.ipHash}:${minute}`, 120),
          incr(`adspam:rc:${keys.ipHash}:${keys.campaignId}:${hour}`, 7200),
          incr(`adspam:rv:${keys.viewerHash}:${keys.campaignId}:${hour}`, 7200),
        ]),
    );
    return {
      addressMinute: Number(addressMinute),
      repeatHour: Math.max(Number(addressHour), Number(viewerHour)),
    };
  }
}
