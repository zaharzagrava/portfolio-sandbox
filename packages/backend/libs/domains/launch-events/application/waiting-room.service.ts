import { ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID, createHash } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { KeyStore } from '@app/domains/identity';
import { RealtimePublisher } from '@app/infrastructure/realtime/realtime-publisher.service';

/** Sub-queues per event: one mega-event's queue would otherwise be a single hot Redis key. */
export const QUEUE_SHARDS = 8;
const TICKET_TTL_SEC = 3_600;
const ADMISSION_TTL_SEC = 600;

const shardOf = (ticket: string) => createHash('sha1').update(ticket).digest().readUInt32BE(0) % QUEUE_SHARDS;
const queueKey = (eventId: string, shard: number) => `wr:{${eventId}:${shard}}:queue`;
const ticketKey = (eventId: string, ticket: string) => `wr:${eventId}:ticket:${ticket}`;
const admittedKey = (eventId: string, ticket: string) => `wr:${eventId}:admitted:${ticket}`;
export const ACTIVE_ROOMS_KEY = 'wr:active';

export interface QueueStatus {
  ticket: string;
  admitted: boolean;
  position?: number;
  admissionToken?: string;
}

/**
 * Virtual waiting room (lesson 10/07 #21, 06/03 §5 admission control):
 * millions arrive at on-sale time, the booking tier admits a fixed rate.
 *  - join: ZADD into one of K sub-queues; people who arrived BEFORE sales
 *    opened get a random position within the first second (refreshing early
 *    gives no advantage - fairness),
 *  - an admitter pops `admissionRatePerSec` per second across the shards and
 *    hands each admitted user a short-lived signed admission token (pushed
 *    over SSE `queue:<ticket>`, also pollable),
 *  - the hold API rejects requests without a valid token for that event+user,
 *    so the database never sees the thundering herd.
 */
@Injectable()
export class WaitingRoomService {
  constructor(
    private readonly redis: RedisService,
    private readonly keys: KeyStore,
    private readonly realtime: RealtimePublisher,
  ) {}

  async join(eventId: string, userId: string, salesOpenAt: Date): Promise<QueueStatus> {
    const existing = await this.redis.client.get(`wr:${eventId}:user:${userId}`);
    if (existing) return this.status(eventId, existing);

    const ticket = randomUUID();
    const now = Date.now();
    const score = now < salesOpenAt.getTime() ? salesOpenAt.getTime() + Math.random() * 1_000 : now;
    const shard = shardOf(ticket);

    await this.redis.client
      .multi()
      .zadd(queueKey(eventId, shard), score, ticket)
      .set(ticketKey(eventId, ticket), userId, 'EX', TICKET_TTL_SEC)
      .set(`wr:${eventId}:user:${userId}`, ticket, 'EX', TICKET_TTL_SEC)
      .sadd(ACTIVE_ROOMS_KEY, eventId)
      .exec();
    return this.status(eventId, ticket);
  }

  async status(eventId: string, ticket: string): Promise<QueueStatus> {
    const token = await this.redis.client.get(admittedKey(eventId, ticket));
    if (token) return { ticket, admitted: true, admissionToken: token };
    const rank = await this.redis.client.zrank(queueKey(eventId, shardOf(ticket)), ticket);
    // Shards drain at the same rate, so rank × shards approximates the global position.
    return { ticket, admitted: false, position: rank === null ? undefined : rank * QUEUE_SHARDS + 1 };
  }

  /** Pops up to `count` users (spread over shards) and admits them. Returns how many were admitted. */
  async admit(eventId: string, count: number): Promise<number> {
    const perShard = Math.ceil(count / QUEUE_SHARDS);
    let admitted = 0;
    for (let shard = 0; shard < QUEUE_SHARDS; shard++) {
      const popped = await this.redis.client.zpopmin(queueKey(eventId, shard), perShard);
      for (let i = 0; i < popped.length; i += 2) {
        const ticket = popped[i];
        const userId = await this.redis.client.get(ticketKey(eventId, ticket));
        if (!userId) continue; // abandoned ticket
        const token = await this.keys.sign(
          { sub: userId, tid: ticket, eventId, purpose: 'admission' },
          { expiresInSec: ADMISSION_TTL_SEC, audience: `admission:${eventId}` },
        );
        await this.redis.client.set(admittedKey(eventId, ticket), token, 'EX', ADMISSION_TTL_SEC);
        await this.realtime.publish(`queue:${ticket}`, 'admitted', { eventId, admissionToken: token });
        admitted++;
      }
    }
    return admitted;
  }

  async queueLength(eventId: string): Promise<number> {
    const sizes = await Promise.all(Array.from({ length: QUEUE_SHARDS }, (_, s) => this.redis.client.zcard(queueKey(eventId, s))));
    return sizes.reduce((a, b) => a + b, 0);
  }

  /** Verifies an admission token for (event, user). Cheap: signature check, no I/O beyond the cached JWKS key. */
  async assertAdmitted(eventId: string, userId: string, token: string | undefined): Promise<void> {
    try {
      if (!token) throw new Error('missing');
      const kid = jwt.decode(token, { complete: true })?.header.kid;
      const key = kid ? await this.keys.verificationKey(kid) : undefined;
      if (!key) throw new Error('unknown key');
      const claims = jwt.verify(token, key.key, { algorithms: [key.alg], audience: `admission:${eventId}`, issuer: 'marketplace' }) as {
        sub: string;
        purpose: string;
      };
      if (claims.purpose !== 'admission' || claims.sub !== userId) throw new Error('wrong subject');
    } catch {
      throw new ForbiddenException('Join the waiting room first (missing or invalid admission token)');
    }
  }
}
