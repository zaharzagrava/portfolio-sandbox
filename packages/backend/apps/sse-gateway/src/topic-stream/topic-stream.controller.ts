import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Query,
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Firewall } from '@app/domains/identity';
import type { RequestWithUser } from '@app/domains/identity';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TopicRegistry } from '@app/infrastructure/realtime/topic-registry';
import {
  decodeCursor,
  encodeCursor,
  MAX_TOPICS_PER_CONNECTION,
  RealtimeMessage,
  RealtimeTopic,
  streamKey,
} from '@app/infrastructure/realtime/topics';
import { SubscriptionHub } from './subscription-hub.service';

const HEARTBEAT_MS = 15_000;
/** A client that can't keep up this much buffered output is dropped; it reconnects and replays. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const REPLAY_LIMIT = 500;

/**
 * GET /api/streams?topics=auction:abc,user:me  (text/event-stream)
 *
 * Delivery guarantee = live push + replay: on (re)connect the client sends
 * Last-Event-ID (a per-topic cursor); we SUBSCRIBE first, buffer live
 * messages, replay the gap from the topic's Redis Stream, then flush the
 * buffer skipping anything already replayed. No gap, no duplicates.
 */
@Controller('streams')
export class TopicStreamController {
  constructor(
    private readonly hub: SubscriptionHub,
    private readonly redis: RedisService,
    private readonly topicRegistry: TopicRegistry,
  ) {}

  @Firewall({ anonymous: true, skipThrottle: true })
  @Get()
  async stream(
    @Query('topics') topicsParam: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Req() req: Request & Partial<RequestWithUser>,
    @Res() res: Response,
  ) {
    const topics = [
      ...new Set(
        (topicsParam ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ];
    if (
      topics.length === 0 ||
      topics.length > MAX_TOPICS_PER_CONNECTION ||
      !topics.every((t) => this.topicRegistry.isKnown(t))
    ) {
      throw new BadRequestException(
        `topics: 1-${MAX_TOPICS_PER_CONNECTION} valid realtime topics`,
      );
    }

    const viewer = {
      userId: req.user?.id,
      roles: req.user?.role ? [req.user.role] : [],
    };
    for (const topic of topics) {
      if (!(await this.topicRegistry.canSubscribe(viewer, topic)))
        throw new ForbiddenException(`not allowed: ${topic}`);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Proxies (nginx/ALB-adjacent) must not buffer the stream.
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    const cursor = decodeCursor(lastEventId, (t) =>
      this.topicRegistry.isKnown(t),
    );
    let closed = false;
    let replaying = true;
    const buffered: RealtimeMessage[] = [];

    const send = (message: RealtimeMessage) => {
      const last = cursor.get(message.topic);
      if (last && compareStreamIds(message.id, last) <= 0) return; // already delivered (replay overlap)
      cursor.set(message.topic, message.id);
      const ok = res.write(
        `id: ${encodeCursor(cursor)}\nevent: ${message.type}\ndata: ${JSON.stringify({ topic: message.topic, data: message.data })}\n\n`,
      );
      if (!ok && res.writableLength > MAX_BUFFERED_BYTES) close();
    };

    const onLive = (message: RealtimeMessage) => {
      if (closed) return;
      if (replaying) buffered.push(message);
      else send(message);
    };

    const unsubscribers = await Promise.all(
      topics.map((t) => this.hub.subscribe(t, onLive)),
    );

    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      void Promise.all(unsubscribers.map((u) => u()));
      res.end();
    };
    req.on('close', close);

    // Replay what was missed while disconnected.
    for (const topic of topics) {
      const from = cursor.get(topic);
      if (!from) continue;
      const entries = await this.redis.client.xrange(
        streamKey(topic),
        `(${from}`,
        '+',
        'COUNT',
        REPLAY_LIMIT,
      );
      for (const [id, fields] of entries) {
        const type = fields[fields.indexOf('type') + 1];
        const data = JSON.parse(fields[fields.indexOf('data') + 1]);
        send({ id, topic, type, data });
      }
    }

    replaying = false;
    for (const message of buffered.splice(0)) send(message);
  }
}

/** Redis Stream ids are `<ms>-<seq>`; compare numerically. */
export function compareStreamIds(a: string, b: string): number {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return am - bm || as - bs;
}
