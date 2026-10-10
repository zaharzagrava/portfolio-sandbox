import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { v7 as uuidv7 } from 'uuid';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { RealtimePublisher } from '@app/infrastructure/realtime';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { channelName, RealtimeMessage } from '@app/infrastructure/realtime';
import { LiveCommentPosted, LiveCommentRemoved } from './events/live-events';
import { syncModeration } from '../domain/moderation';
import {
  ACTIVE_STREAMS,
  ALLOWED_REACTIONS,
  bannedKey,
  firehoseTopic,
  LiveComment,
  pinKey,
  REACTION_SHARDS,
  reactionKey,
  RECENT_COMMENTS,
  recentKey,
  Reaction,
} from '../infra/live-keys';

export interface LiveStreamRow {
  id: string;
  shopId: string;
  title: string;
  status: 'SCHEDULED' | 'LIVE' | 'ENDED';
}

export interface Pin {
  productId: string;
  text: string;
  stockLeft?: number;
}

/**
 * Write side of live chat. A comment costs: one Redis pipeline (recent list +
 * firehose publish) + one Kafka produce. Nothing touches Postgres or Dynamo
 * synchronously - persistence is a consumer (D18: Kafka for the fan-out /
 * history stream). Reactions cost one HINCRBY on a sharded per-second hash.
 */
@Injectable()
export class LiveService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly redis: RedisService,
    private readonly realtime: RealtimePublisher,
    private readonly producer: KafkaProducerService,
  ) {}

  async create(shopId: string, title: string, launchEventId?: string) {
    const [row] = await this.sequelize.query<LiveStreamRow>(
      `INSERT INTO "LiveStream" ("shopId", title, "launchEventId") VALUES (:shopId, :title, :launchEventId) RETURNING id, "shopId", title, status`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId, title, launchEventId: launchEventId ?? null },
      },
    );
    return row;
  }

  async setStatus(shopId: string, streamId: string, status: 'LIVE' | 'ENDED') {
    const rows = await this.sequelize.query<LiveStreamRow>(
      `UPDATE "LiveStream" SET status = :status,
              "startedAt" = CASE WHEN :status = 'LIVE' THEN coalesce("startedAt", now()) ELSE "startedAt" END,
              "endedAt" = CASE WHEN :status = 'ENDED' THEN now() ELSE "endedAt" END
       WHERE id = :streamId AND "shopId" = :shopId AND status <> 'ENDED' RETURNING id, "shopId", title, status`,
      { type: QueryTypes.SELECT, replacements: { streamId, shopId, status } },
    );
    if (!rows[0]) throw new NotFoundException('Stream not found');
    if (status === 'LIVE')
      await this.redis.client.sadd(ACTIVE_STREAMS, streamId);
    else await this.redis.client.srem(ACTIVE_STREAMS, streamId);
    await this.realtime.publish(`stream:${streamId}`, 'status', { status });
    return rows[0];
  }

  async get(streamId: string): Promise<LiveStreamRow | null> {
    const [row] = await this.sequelize.query<LiveStreamRow>(
      `SELECT id, "shopId", title, status FROM "LiveStream" WHERE id = :streamId`,
      {
        type: QueryTypes.SELECT,
        replacements: { streamId },
      },
    );
    return row ?? null;
  }

  async comment(
    streamId: string,
    author: { id: string; name: string; isStaff: boolean },
    text: string,
  ): Promise<LiveComment> {
    if (!(await this.redis.client.sismember(ACTIVE_STREAMS, streamId)))
      throw new ConflictException('Stream is not live');
    if (await this.redis.client.sismember(bannedKey(streamId), author.id))
      throw new ForbiddenException('You are muted in this stream');
    const verdict = syncModeration(text);
    if (!verdict.ok) throw new UnprocessableEntityException(verdict.reason);

    const comment: LiveComment = {
      id: uuidv7(),
      streamId,
      authorId: author.id,
      authorName: author.name,
      text,
      at: Date.now(),
      ...(author.isStaff && { priority: true }),
    };
    const message: RealtimeMessage = {
      id: '0-0',
      topic: `stream:${streamId}`,
      type: 'comment',
      data: comment,
    };
    await this.redis.client
      .multi()
      .lpush(recentKey(streamId), JSON.stringify(comment))
      .ltrim(recentKey(streamId), 0, RECENT_COMMENTS - 1)
      .exec();
    await this.redis.client.publish(
      channelName(firehoseTopic(streamId)),
      JSON.stringify(message),
    );
    await this.producer.send({
      topic: LiveCommentPosted.topic,
      key: streamId,
      value: LiveCommentPosted.create(streamId, 0, {
        streamId,
        commentId: comment.id,
        authorId: author.id,
        authorName: author.name,
        text,
        at: comment.at,
      }),
    });
    return comment;
  }

  /**
   * Clients batch locally (taps over ~1 s → `{ "❤️": 7 }`), so 200k taps/s is
   * ~20k requests/s. Counted into the current second's hash on a random shard;
   * the ticker sums the shards once per second and broadcasts totals.
   */
  async react(
    streamId: string,
    reactions: Partial<Record<Reaction, number>>,
  ): Promise<void> {
    const second = Math.floor(Date.now() / 1000);
    const key = reactionKey(
      streamId,
      second,
      Math.floor(Math.random() * REACTION_SHARDS),
    );
    const pipeline = this.redis.client.pipeline();
    for (const [emoji, count] of Object.entries(reactions)) {
      if (!ALLOWED_REACTIONS.includes(emoji as Reaction) || !count) continue;
      pipeline.hincrby(
        key,
        emoji,
        Math.min(Math.max(Math.floor(count), 0), 20),
      );
    }
    pipeline.expire(key, 10);
    await pipeline.exec();
  }

  async recent(streamId: string): Promise<LiveComment[]> {
    return (
      await this.redis.client.lrange(
        recentKey(streamId),
        0,
        RECENT_COMMENTS - 1,
      )
    )
      .map((s) => JSON.parse(s) as LiveComment)
      .reverse();
  }

  async pin(streamId: string, pin: Pin | null) {
    if (pin)
      await this.redis.client.set(
        pinKey(streamId),
        JSON.stringify(pin),
        'EX',
        24 * 3600,
      );
    else await this.redis.client.del(pinKey(streamId));
    await this.realtime.publish(`stream:${streamId}`, 'pin', pin);
  }

  async currentPin(streamId: string): Promise<Pin | null> {
    const raw = await this.redis.client.get(pinKey(streamId));
    return raw ? (JSON.parse(raw) as Pin) : null;
  }

  /** Moderator or async classifier: clients drop it, history marks it removed. */
  async remove(streamId: string, commentId: string, reason: string) {
    const recent = await this.redis.client.lrange(recentKey(streamId), 0, -1);
    const hit = recent.find(
      (s) => (JSON.parse(s) as LiveComment).id === commentId,
    );
    if (hit) await this.redis.client.lrem(recentKey(streamId), 1, hit);
    await this.realtime.publish(`stream:${streamId}`, 'comment_removed', {
      id: commentId,
    });
    await this.producer.send({
      topic: LiveCommentRemoved.topic,
      key: streamId,
      value: LiveCommentRemoved.create(streamId, 0, {
        streamId,
        commentId,
        at: Date.now(),
        reason,
      }),
    });
  }

  async mute(streamId: string, userId: string) {
    await this.redis.client
      .multi()
      .sadd(bannedKey(streamId), userId)
      .expire(bannedKey(streamId), 7 * 86_400)
      .exec();
  }
}
