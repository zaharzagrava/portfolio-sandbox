import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { DraftStore } from '../domain/ports';

export const draftKey = (shopId: string) => `onboarding:draft:${shopId}`;

/** Sliding: every save extends it, so an abandoned draft cleans itself up a week after the last touch (FR-002). */
export const DRAFT_TTL_S = 7 * 86_400;

/**
 * Seeds the hash from the last submitted answers when it does not exist yet (the first save after a rejection, FR-005),
 * then writes the step and resets the lifetime - all in one script, so concurrent saves of different steps neither lose
 * a field nor leave a hash without a lifetime.
 */
const SAVE_STEP = `
if ARGV[3] ~= '' and redis.call('EXISTS', KEYS[1]) == 0 then
  local seed = cjson.decode(ARGV[3])
  for step, value in pairs(seed) do redis.call('HSET', KEYS[1], step, value) end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1`;

@Injectable()
export class RedisDraftStore implements DraftStore {
  constructor(private readonly redis: RedisService) {}

  async saveStep(
    shopId: string,
    step: string,
    value: unknown,
    seed: Record<string, unknown> | null,
  ): Promise<void> {
    await this.redis.client.eval(
      SAVE_STEP,
      1,
      draftKey(shopId),
      step,
      JSON.stringify(value),
      // each step is encoded here, so the script never re-encodes (Lua's cjson turns an empty array into an object)
      seed
        ? JSON.stringify(
            Object.fromEntries(
              Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]),
            ),
          )
        : '',
      String(DRAFT_TTL_S),
    );
  }

  async read(shopId: string): Promise<Record<string, unknown>> {
    const raw = await this.redis.client.hgetall(draftKey(shopId));
    const draft: Record<string, unknown> = {};
    for (const [step, json] of Object.entries(raw)) {
      try {
        draft[step] = JSON.parse(json);
      } catch {
        // a corrupt field is treated as a missing step: the seller saves it again
      }
    }
    return draft;
  }

  async delete(shopId: string): Promise<void> {
    await this.redis.client.del(draftKey(shopId));
  }
}
