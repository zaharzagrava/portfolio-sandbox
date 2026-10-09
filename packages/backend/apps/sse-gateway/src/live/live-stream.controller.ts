import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Firewall } from '@app/domains/identity';
import type { RequestWithUser } from '@app/domains/identity';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  ACTIVE_STREAMS,
  LiveComment,
  pinKey,
  RECENT_COMMENTS,
  recentKey,
} from '@app/domains/launch-events';
import { LiveBatcherRegistry, LiveViewer } from './live-batcher.service';

const HEARTBEAT_MS = 15_000;
/** Live chat is lossy by design: a viewer this far behind is dropped and reconnects to a fresh snapshot. */
const MAX_BUFFERED_BYTES = 256 * 1024;

/**
 * GET /api/live/:streamId/events (text/event-stream)
 * First event `snapshot` (recent comments + pin) for late joiners, then
 * batched `comments` every 250 ms, plus `stats` / `pin` / `comment_removed` / `status`.
 * No Last-Event-ID replay: reconnecting gets a fresh snapshot instead (chat is ephemeral).
 */
@Controller('live')
export class LiveStreamController {
  constructor(
    private readonly registry: LiveBatcherRegistry,
    private readonly redis: RedisService,
  ) {}

  @Firewall({ anonymous: true, skipThrottle: true })
  @Get(':streamId/events')
  async events(
    @Param('streamId', ParseUUIDPipe) streamId: string,
    @Req() req: Request & Partial<RequestWithUser>,
    @Res() res: Response,
  ) {
    if (!(await this.redis.client.sismember(ACTIVE_STREAMS, streamId)))
      throw new NotFoundException('Stream is not live');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    let closed = false;
    const viewer: LiveViewer = {
      userId: req.user?.id,
      send: (event, data) => {
        if (closed) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (res.writableLength > MAX_BUFFERED_BYTES) close();
      },
    };

    const [recent, pin] = await Promise.all([
      this.redis.client.lrange(recentKey(streamId), 0, RECENT_COMMENTS - 1),
      this.redis.client.get(pinKey(streamId)),
    ]);
    viewer.send('snapshot', {
      recent: recent.map((s) => JSON.parse(s) as LiveComment).reverse(),
      pin: pin ? JSON.parse(pin) : null,
    });

    const leave = await this.registry.join(streamId, viewer);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      void leave();
      res.end();
    };
    req.on('close', close);
  }
}
