import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { REMOVAL_CLAIM_TTL_SEC } from '../../domain/live-constants';
import { removalClaimKey } from '../../domain/live-keys';
import type { RemovalClaims } from '../../domain/live-ports';

/** At most one `live.comment_removed` per comment within 24 hours: claimed before the durable write, released on failure. */
@Injectable()
export class RedisRemovalClaims implements RemovalClaims {
  constructor(private readonly redis: RedisService) {}

  async claim(streamId: string, commentId: string): Promise<boolean> {
    const set = await this.redis.client.set(
      removalClaimKey(streamId, commentId),
      '1',
      'EX',
      REMOVAL_CLAIM_TTL_SEC,
      'NX',
    );
    return set === 'OK';
  }

  async isClaimed(streamId: string, commentId: string): Promise<boolean> {
    return (
      (await this.redis.client.exists(removalClaimKey(streamId, commentId))) ===
      1
    );
  }

  async release(streamId: string, commentId: string): Promise<void> {
    await this.redis.client.del(removalClaimKey(streamId, commentId));
  }
}
