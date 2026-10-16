import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { RECENT_COMMENTS } from '../../domain/live-constants';
import { recentKey } from '../../domain/live-keys';
import type { LiveComment } from '../../domain/live-constants';
import type { RecentCommentStore } from '../../domain/live-ports';

const KEY_TTL_SEC = 7 * 24 * 3600;
/**
 * The list keeps more than the 50 a snapshot shows, so that removals leave the snapshot full: the last 50 NON-REMOVED
 * comments are what a late joiner sees (FR-014).
 */
const KEPT = 2 * RECENT_COMMENTS;

/** Canonical JSON of a comment: the same comment always serializes to the same member, so a retried add is a no-op. */
const member = (c: LiveComment): string =>
  JSON.stringify({
    id: c.id,
    streamId: c.streamId,
    authorId: c.authorId,
    authorName: c.authorName,
    text: c.text,
    at: c.at,
    ...(c.priority && { priority: true }),
  });

/** The last 50 comments of a stream as a sorted set scored by time (idempotent add, trimmed to the newest 50). */
@Injectable()
export class RedisRecentCommentStore implements RecentCommentStore {
  constructor(private readonly redis: RedisService) {}

  async add(comment: LiveComment): Promise<void> {
    const key = recentKey(comment.streamId);
    await this.redis.client
      .multi()
      .zadd(key, 'NX', comment.at, member(comment))
      .zremrangebyrank(key, 0, -(KEPT + 1))
      .expire(key, KEY_TTL_SEC)
      .exec();
  }

  async list(streamId: string): Promise<LiveComment[]> {
    const raw = await this.redis.client.zrange(recentKey(streamId), 0, -1);
    return raw
      .map((s) => JSON.parse(s) as LiveComment)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(-RECENT_COMMENTS);
  }

  async remove(streamId: string, commentId: string): Promise<boolean> {
    const key = recentKey(streamId);
    const raw = await this.redis.client.zrange(key, 0, -1);
    const hit = raw.find(
      (s) => (JSON.parse(s) as LiveComment).id === commentId,
    );
    if (!hit) return false;
    return (await this.redis.client.zrem(key, hit)) > 0;
  }
}
