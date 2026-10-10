import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { SnapshotPointer } from '../domain/autocomplete-ports';
import { canAdvance } from '../domain/snapshot-pointer';

export const AUTOCOMPLETE_POINTER = 'autocomplete:current';
const MAX_ATTEMPTS = 5;

/** Sets the key only if it still holds the value the caller judged against (`''` = absent). */
const SET_IF_UNCHANGED = `
local cur = redis.call('GET', KEYS[1])
if (cur == false and ARGV[1] == '') or cur == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  return 1
end
return 0`;

/**
 * `SnapshotPointer` over Redis key `autocomplete:current`. The forward-only rule is the domain's `canAdvance`; the script
 * makes the check-and-set atomic, so two overlapping builds cannot move the pointer backwards (R-6).
 */
@Injectable()
export class SnapshotPointerAdapter implements SnapshotPointer {
  constructor(private readonly redis: RedisService) {}

  read(): Promise<string | null> {
    return this.redis.client.get(AUTOCOMPLETE_POINTER);
  }

  async compareAndSet(version: string): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = await this.read();
      if (!canAdvance(current, version)) return false;
      const moved = await this.redis.client.eval(
        SET_IF_UNCHANGED,
        1,
        AUTOCOMPLETE_POINTER,
        current ?? '',
        version,
      );
      if (moved === 1) return true;
    }
    return false;
  }

  async forceSet(version: string): Promise<void> {
    await this.redis.client.set(AUTOCOMPLETE_POINTER, version);
  }
}
