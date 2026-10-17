import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { DRAFT_LIMITS } from '../domain/draft-limits';
import type { TicketIdStore } from '../domain/draft-ports';
import { withTimeout } from './timeouts';

/**
 * Single use of a ticket (S06 FR-009): `SET collab:ticket:<jti> 1 NX EX 60`. Called only after the room accepted the join,
 * so a redirect to the owning instance (close 4001) never burns the ticket. A Redis failure is an error, never a grant.
 */
@Injectable()
export class RedisTicketIdStore implements TicketIdStore {
  constructor(private readonly redis: RedisService) {}

  async consume(jti: string, ttlSeconds: number): Promise<boolean> {
    const reply = await withTimeout(
      'ticket consume',
      DRAFT_LIMITS.redisTimeoutMs,
      () =>
        this.redis.client.set(
          `collab:ticket:${jti}`,
          '1',
          'EX',
          ttlSeconds,
          'NX',
        ),
    );
    return reply === 'OK';
  }
}
