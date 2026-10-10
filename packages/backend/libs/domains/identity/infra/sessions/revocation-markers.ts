import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ACCESS_TOKEN_TTL_SEC } from '../../domain/session-policy';

/** A marker has to outlive every access token the session could still hold, plus clock tolerance. */
const MARKER_TTL_SEC = ACCESS_TOKEN_TTL_SEC + 60;

/**
 * Redis markers `auth:revoked:<sid>` that let sensitive routes reject a revoked session's access tokens at once
 * (FR-025). The durable record is the session item; the marker is written second and an error here is surfaced, never
 * swallowed (R-02).
 */
@Injectable()
export class RevocationMarkers {
  constructor(private readonly redis: RedisService) {}

  async mark(sid: string, reason: string): Promise<void> {
    await this.redis.client.set(
      `auth:revoked:${sid}`,
      reason,
      'EX',
      MARKER_TTL_SEC,
    );
  }

  /** Throws when Redis is unreachable: callers on sensitive routes fail closed. */
  async isRevoked(sid: string): Promise<boolean> {
    return (await this.redis.client.exists(`auth:revoked:${sid}`)) === 1;
  }
}
