import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { GATE_TTL_SEC } from '../../domain/constants';
import type { EventGate, GateRecord } from '../../domain/ports';

const gateKey = (eventId: string) => `gate:{${eventId}}`;

/** Short-TTL mirror of the event facts the hot paths decide on (D-7): written on every status change, rebuilt on a miss. */
@Injectable()
export class RedisEventGate implements EventGate {
  constructor(private readonly redis: RedisService) {}

  async get(eventId: string): Promise<GateRecord | null> {
    const raw = await this.redis.client.get(gateKey(eventId));
    return raw ? (JSON.parse(raw) as GateRecord) : null;
  }

  async put(record: GateRecord): Promise<void> {
    await this.redis.client.set(
      gateKey(record.eventId),
      JSON.stringify(record),
      'EX',
      GATE_TTL_SEC,
    );
  }

  async del(eventId: string): Promise<void> {
    await this.redis.client.del(gateKey(eventId));
  }
}
