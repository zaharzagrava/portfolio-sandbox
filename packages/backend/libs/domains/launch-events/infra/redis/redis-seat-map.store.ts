import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { DERIVED_KEY_TTL_SEC } from '../../domain/constants';
import { fitBitmap } from '../../domain/seat-bitmap';
import type { SeatMapSnapshot, SeatMapStore } from '../../domain/ports';
import { MAP_APPLY, MAP_READ, MAP_SEED } from './lua';

const mapKey = (eventId: string) => `sm:{${eventId}}`;
const seqKey = (eventId: string) => `sm:{${eventId}}:seq`;

/** The seat map picture (P0323): a 1-bit-per-seat bitmap with a `seq` assigned in the same script as the bit. */
@Injectable()
export class RedisSeatMapStore implements SeatMapStore {
  constructor(private readonly redis: RedisService) {
    // The map is binary: the script is read back through the Buffer variant that `defineCommand` creates.
    if (!('launchMapRead' in this.redis.client))
      this.redis.client.defineCommand('launchMapRead', {
        numberOfKeys: 2,
        lua: MAP_READ,
      });
  }

  async read(
    eventId: string,
    seatCount: number,
  ): Promise<SeatMapSnapshot | null> {
    const reply = await (
      this.redis.client as unknown as {
        launchMapReadBuffer(...keys: string[]): Promise<Buffer[] | null>;
      }
    ).launchMapReadBuffer(mapKey(eventId), seqKey(eventId));
    if (!reply) return null;
    return {
      bitmap: fitBitmap(reply[0], seatCount),
      seq: Number(reply[1].toString('utf8')),
    };
  }

  async apply(
    eventId: string,
    seats: number[],
    set: boolean,
  ): Promise<{ seq: number } | null> {
    if (seats.length === 0) return null;
    const seq = (await this.redis.client.eval(
      MAP_APPLY,
      2,
      mapKey(eventId),
      seqKey(eventId),
      set ? 1 : 0,
      DERIVED_KEY_TTL_SEC,
      ...seats,
    )) as number;
    return seq < 0 ? null : { seq };
  }

  async seed(
    eventId: string,
    bitmap: Buffer,
    seq: number,
  ): Promise<SeatMapSnapshot> {
    await this.redis.client.eval(
      MAP_SEED,
      2,
      mapKey(eventId),
      seqKey(eventId),
      bitmap,
      String(seq),
      DERIVED_KEY_TTL_SEC,
    );
    // Whoever seeded first wins; everyone reads what is there.
    const read = await this.read(eventId, bitmap.length * 8);
    return read ?? { bitmap, seq };
  }
}
