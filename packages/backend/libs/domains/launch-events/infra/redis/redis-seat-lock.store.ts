import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { HOLD_MS } from '../../domain/constants';
import type { SeatLockStore } from '../../domain/ports';
import { SEAT_LOCK_KEEP, SEAT_LOCK_RELEASE, SEAT_LOCK_TRY } from './lua';

const lockKey = (eventId: string, seat: number) => `sl:{${eventId}}:${seat}`;
const BOOKED_LOCK_MS = 7 * 24 * 3600 * 1000;

/** First filter per seat (`SET NX PX`, no waiting). The ledger decides; a lock never grants a seat on its own. */
@Injectable()
export class RedisSeatLockStore implements SeatLockStore {
  constructor(private readonly redis: RedisService) {}

  async tryLock(
    eventId: string,
    seat: number,
    holdId: string,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<boolean> {
    const taken = await this.redis.client.eval(
      SEAT_LOCK_TRY,
      1,
      lockKey(eventId, seat),
      `${holdId}:${expiresAtMs}`,
      HOLD_MS,
      nowMs,
    );
    return taken === 1;
  }

  async release(eventId: string, seat: number, holdId: string): Promise<void> {
    await this.redis.client.eval(
      SEAT_LOCK_RELEASE,
      1,
      lockKey(eventId, seat),
      holdId,
    );
  }

  async keepBooked(
    eventId: string,
    seat: number,
    holdId: string,
  ): Promise<void> {
    await this.redis.client.eval(
      SEAT_LOCK_KEEP,
      1,
      lockKey(eventId, seat),
      holdId,
      BOOKED_LOCK_MS,
    );
  }
}
