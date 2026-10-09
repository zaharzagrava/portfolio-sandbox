import { Injectable, Logger } from '@nestjs/common';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { FeedItemPublished } from '../application/feed-publisher.service';
import {
  activeKey,
  CELEBRITIES,
  celebKey,
  timelineKey,
  TIMELINE_LENGTH,
} from '../application/feed.service';
import { encodeEntry } from '../domain/merge';

const FOLLOWER_PAGE = 1_000;

/**
 * Fan-out on write for normal authors (F-05 consumer, `feed.events` keyed by
 * author → one author's items are processed in order). Pages through
 * followers 1,000 at a time; per page ONE pipelined round trip checks who is
 * active and pushes to their lists. Celebrity items go to a single capped
 * ZSET instead (pulled at read time). Backpressure: the runner pauses the
 * partition if Redis signals saturation.
 */
@Injectable()
export class FeedFanoutConsumer implements Projector {
  private readonly logger = new Logger(FeedFanoutConsumer.name);
  readonly name = 'feed-fanout';
  readonly topics = [FeedItemPublished.topic];
  // Pushing the same entry to a timeline twice shows it twice, so the framework records each event once.
  readonly idempotency = 'inbox' as const;
  readonly handles = [{ event: FeedItemPublished }];

  constructor(
    private readonly cassandra: CassandraService,
    private readonly redis: RedisService,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    for (const raw of events) {
      const event = FeedItemPublished.match(raw);
      if (event)
        await this.fanOut(
          event.payload.authorId,
          event.payload.itemId,
          event.payload.ms,
        );
    }
  }

  async fanOut(
    authorId: string,
    itemId: string,
    ms: number,
  ): Promise<{ pushed: number; celebrity: boolean }> {
    const entry = encodeEntry({ ms, itemId });
    if (await this.redis.client.sismember(CELEBRITIES, authorId)) {
      await this.redis.client
        .multi()
        .zadd(celebKey(authorId), ms, entry)
        .zremrangebyrank(celebKey(authorId), 0, -201)
        .exec();
      return { pushed: 0, celebrity: true };
    }

    let pushed = 0;
    let pageState: string | undefined;
    do {
      const page = await this.cassandra.execute(
        'SELECT follower_id FROM followers_by_account WHERE account_id = ?',
        [authorId],
        {
          fetchSize: FOLLOWER_PAGE,
          pageState,
        },
      );
      const followers = page.rows.map(
        (r) => r.follower_id.toString() as string,
      );
      const active = await this.redis.client
        .pipeline(followers.map((f) => ['exists', activeKey(f)]))
        .exec();
      const pipeline = this.redis.client.pipeline();
      followers.forEach((follower, i) => {
        if (active?.[i]?.[1] !== 1) return; // inactive: rebuilt by pull when they come back
        pipeline
          .lpush(timelineKey(follower), entry)
          .ltrim(timelineKey(follower), 0, TIMELINE_LENGTH - 1);
        pushed++;
      });
      await pipeline.exec();
      pageState = page.pageState ?? undefined;
    } while (pageState);

    if (pushed > 50_000)
      this.logger.warn(`large fan-out: ${authorId} → ${pushed} timelines`);
    return { pushed, celebrity: false };
  }
}
