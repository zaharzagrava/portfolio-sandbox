import { Injectable } from '@nestjs/common';
import { types } from 'cassandra-driver';
import { z } from 'zod';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { defineEvent } from '@app/infrastructure/events/define-event';

export const FeedItemPublished = defineEvent(
  'feed.item_published',
  'feed',
  1,
  z.object({
    itemId: z.string(),
    authorId: z.string(),
    ms: z.number().int(),
  }),
);

export type FeedItemKind =
  'new_product' | 'price_drop' | 'drop_announced' | 'post' | 'auction_started';

export const monthOf = (ms: number) => {
  const d = new Date(ms);
  return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1;
};

/**
 * Turns something that happened (a shop listed a product, a buyer posted in
 * a discussion) into a feed item: stored once (`feed_items`, `items_by_author`),
 * then a `feed.events` message keyed by author drives the asynchronous fan-out.
 * The author's request never waits on N follower writes.
 */
@Injectable()
export class FeedPublisher {
  constructor(
    private readonly cassandra: CassandraService,
    private readonly producer: KafkaProducerService,
  ) {}

  async publish(
    authorId: string,
    kind: FeedItemKind,
    title: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const itemId = types.TimeUuid.now();
    const ms = itemId.getDate().getTime();
    await Promise.all([
      this.cassandra.execute(
        'INSERT INTO feed_items (item_id, author_id, kind, title, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [itemId, authorId, kind, title, JSON.stringify(payload), new Date(ms)],
      ),
      this.cassandra.execute(
        'INSERT INTO items_by_author (author_id, month, item_id) VALUES (?, ?, ?)',
        [authorId, monthOf(ms), itemId],
      ),
    ]);
    const event = FeedItemPublished.create(authorId, 0, {
      itemId: itemId.toString(),
      authorId,
      ms,
    });
    await this.producer.send({
      topic: FeedItemPublished.topic,
      key: authorId,
      value: event,
    });
    return itemId.toString();
  }
}
