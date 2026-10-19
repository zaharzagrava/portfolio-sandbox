import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { HEARTBEAT_MS, QUEUE_SHARDS } from '../../domain/constants';
import type {
  AdmitCandidate,
  AdmittedItem,
  JoinResult,
  QueueStore,
  TicketView,
} from '../../domain/ports';
import type { BucketState } from '../../domain/token-bucket';
import { COMMIT, JOIN, PEEK, RETRACT, VIEW } from './lua';

/** Lifetime of the queue's keys: refreshed by every join; a sale that lasts longer than a day is not a waiting room. */
const QUEUE_TTL_SEC = 24 * 3600;
const ACTIVE_KEY = 'lr:active';

export const shardOf = (ticket: string) =>
  createHash('sha1').update(ticket).digest().readUInt32BE(0) % QUEUE_SHARDS;

const userKey = (eventId: string, userId: string) =>
  `lu:{${eventId}}:${userId}`;
const ticketKey = (eventId: string, ticket: string) =>
  `lt:{${eventId}}:${ticket}`;
const shardKey = (eventId: string, shard: number) => `lq:{${eventId}}:${shard}`;
const bucketKey = (eventId: string) => `la:{${eventId}}:bucket`;
const ownerKey = (ticket: string) => `lo:${ticket}`;

/** The sharded waiting room in Redis (P0323): sorted sets per shard, a hash per ticket, atomic scripts. */
@Injectable()
export class RedisQueueStore implements QueueStore {
  constructor(private readonly redis: RedisService) {}

  async join(input: {
    eventId: string;
    userId: string;
    newTicket: string;
    score: number;
    nowMs: number;
    maxLength: number;
  }): Promise<JoinResult> {
    const { eventId, userId, newTicket } = input;
    const reply = (await this.redis.client.eval(
      JOIN,
      1,
      userKey(eventId, userId),
      eventId,
      newTicket,
      String(input.score),
      input.nowMs,
      input.maxLength,
      HEARTBEAT_MS,
      QUEUE_TTL_SEC,
      QUEUE_SHARDS,
      shardOf(newTicket),
      userId,
    )) as string[];
    if (reply[0] === 'full') return { kind: 'full' };
    if (reply[0] === 'created')
      await this.redis.client.set(
        ownerKey(newTicket),
        `${eventId}:${userId}`,
        'EX',
        QUEUE_TTL_SEC,
      );
    return { kind: reply[0] as 'created' | 'existing', ticket: reply[1] };
  }

  async retract(
    eventId: string,
    ticket: string,
    userId: string,
  ): Promise<void> {
    await this.redis.client.eval(
      RETRACT,
      1,
      userKey(eventId, userId),
      eventId,
      ticket,
    );
    await this.redis.client.del(ownerKey(ticket));
  }

  async view(
    eventId: string,
    ticket: string,
    userId: string,
    nowMs: number,
  ): Promise<TicketView | null> {
    const reply = (await this.redis.client.eval(
      VIEW,
      0,
      eventId,
      ticket,
      userId,
      nowMs,
      HEARTBEAT_MS,
      QUEUE_SHARDS,
    )) as string[] | null;
    if (!reply) return null;
    if (reply[0] === 'admitted')
      return {
        ticket,
        admitted: true,
        queueLength: 0,
        expiresAtMs: Number(reply[2]),
        admissionToken: reply[1],
        tokenExpiresAtMs: Number(reply[2]),
        admittedAtMs: Number(reply[3]),
      };
    return {
      ticket,
      admitted: false,
      position: Number(reply[1]),
      queueLength: Number(reply[2]),
      expiresAtMs: nowMs + HEARTBEAT_MS,
    };
  }

  async ownerOf(ticket: string): Promise<string | null> {
    const value = await this.redis.client.get(ownerKey(ticket));
    return value ? value.slice(value.indexOf(':') + 1) : null;
  }

  async length(eventId: string): Promise<number> {
    const sizes = await Promise.all(
      Array.from({ length: QUEUE_SHARDS }, (_, s) =>
        this.redis.client.zcard(shardKey(eventId, s)),
      ),
    );
    return sizes.reduce((a, b) => a + b, 0);
  }

  activeEvents(): Promise<string[]> {
    return this.redis.client.smembers(ACTIVE_KEY);
  }

  async retire(eventId: string): Promise<void> {
    await this.redis.client.srem(ACTIVE_KEY, eventId);
  }

  async clear(eventId: string): Promise<void> {
    for (let shard = 0; shard < QUEUE_SHARDS; shard++) {
      const tickets = await this.redis.client.zrange(
        shardKey(eventId, shard),
        0,
        -1,
      );
      const pipeline = this.redis.client.pipeline();
      for (const ticket of tickets) pipeline.del(ticketKey(eventId, ticket));
      pipeline.del(shardKey(eventId, shard));
      await pipeline.exec();
    }
    await this.redis.client.srem(ACTIVE_KEY, eventId);
  }

  async bucket(eventId: string): Promise<BucketState | null> {
    const h = await this.redis.client.hgetall(bucketKey(eventId));
    return h.tokens === undefined
      ? null
      : { tokens: Number(h.tokens), atMs: Number(h.at) };
  }

  async peek(input: {
    eventId: string;
    want: number;
    fence: number;
    nowMs: number;
  }): Promise<{ stale: boolean; tickets: AdmitCandidate[] }> {
    const reply = (await this.redis.client.eval(
      PEEK,
      0,
      input.eventId,
      input.want,
      input.fence,
      input.nowMs,
      HEARTBEAT_MS,
      QUEUE_SHARDS,
      QUEUE_TTL_SEC,
    )) as string[];
    if (reply[0] === 'stale') return { stale: true, tickets: [] };
    const tickets: AdmitCandidate[] = [];
    for (let i = 1; i < reply.length; i += 2)
      tickets.push({ ticket: reply[i], userId: reply[i + 1] });
    return { stale: false, tickets };
  }

  async commit(input: {
    eventId: string;
    fence: number;
    nowMs: number;
    items: AdmittedItem[];
    bucketBefore: BucketState;
  }): Promise<{ stale: boolean; admitted: AdmittedItem[] }> {
    const args: (string | number)[] = [
      input.eventId,
      input.fence,
      input.nowMs,
      QUEUE_TTL_SEC,
      input.bucketBefore.tokens,
      input.items.length,
    ];
    for (const item of input.items)
      args.push(item.ticket, item.userId, item.token, item.tokenExpiresAtMs);
    const reply = (await this.redis.client.eval(
      COMMIT,
      0,
      ...args,
    )) as string[];
    if (reply[0] === 'stale') return { stale: true, admitted: [] };
    const done = new Set(reply.slice(1));
    return {
      stale: false,
      admitted: input.items.filter((item) => done.has(item.ticket)),
    };
  }

  async claimHumanResult(fingerprint: string): Promise<boolean> {
    const reply = await this.redis.client.set(
      `hc:${fingerprint}`,
      '1',
      'EX',
      3600,
      'NX',
    );
    return reply === 'OK';
  }
}
