import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Firewall } from '@app/domains/identity';
import type { RequestWithUser } from '@app/domains/identity';
import { LiveLimits } from '../application/live-limits';
import { liveMetrics } from '../application/live-metrics';
import { LiveSnapshotService } from '../application/live-snapshot.service';
import { UuidParamPipe } from '../api/pipes';
import { KEEP_ALIVE_MS, MAX_BUFFERED_BYTES } from '../domain/live-constants';
import {
  gatewayFull,
  or503,
  streamEnded,
  streamNotFound,
} from './live-gateway-errors';
import {
  LIVE_SETTINGS,
  LIVE_TIMERS,
  type LiveSettings,
  type LiveTimers,
} from '../domain/live-ports';
import type { LiveViewer } from './live-batcher.service';
import { LiveViewerRegistry } from './live-viewer-registry';

/**
 * GET /api/live/:streamId/events (text/event-stream), anonymous (a signed-in viewer's own comments are flagged `mine`).
 * Delivery is established FIRST (the viewer joins its stream's batcher and buffers what arrives), the snapshot is read
 * SECOND and sent as the first frame, then the buffer, then live events: nothing published in between is lost (FR-013).
 * No Last-Event-ID replay: a reconnect gets a fresh snapshot (chat is ephemeral).
 */
@Controller('live')
export class LiveStreamController {
  constructor(
    private readonly registry: LiveViewerRegistry,
    private readonly snapshots: LiveSnapshotService,
    private readonly limits: LiveLimits,
    @Inject(LIVE_SETTINGS) private readonly settings: LiveSettings,
    @Inject(LIVE_TIMERS) private readonly timers: LiveTimers,
  ) {}

  @Firewall({ anonymous: true })
  @Get(':streamId/events')
  async events(
    @Param('streamId', new UuidParamPipe('streamId')) streamId: string,
    @Req() req: Request & Partial<RequestWithUser>,
    @Res() res: Response,
  ): Promise<void> {
    await this.limits.take('live.events.ip', `ip:${req.ip ?? 'unknown'}`);
    const known = await or503(() => this.snapshots.stateOf(streamId));
    if (!known) throw streamNotFound();
    if (known.status === 'ENDED') throw streamEnded();
    if (this.registry.isFull()) throw gatewayFull();

    const maxBuffered = this.settings.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
    let closed = false;
    let buffering = true;
    const queue: [string, unknown][] = [];
    // Set once the connection is joined and the keep-alive timer runs; `close` may be called before that.
    const connection: {
      stopHeartbeat?: () => void;
      leave?: () => Promise<void>;
    } = {};

    const write = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (res.writableLength > maxBuffered) viewer.close('slow');
    };
    const viewer: LiveViewer = {
      userId: req.user?.id,
      send: (event, data) => {
        if (closed) return;
        if (buffering) queue.push([event, data]);
        else write(event, data);
      },
      close: (reason) => {
        if (closed) return;
        closed = true;
        connection.stopHeartbeat?.();
        liveMetrics.viewersDropped.add(1, { reason });
        void connection.leave?.();
        res.end();
      },
    };

    const leave = await or503(() => this.registry.join(streamId, viewer));
    connection.leave = leave;
    let snapshot;
    try {
      // Read after joining: whatever changed before this point is in it, whatever changes later arrives as an event.
      const fresh = await this.snapshots.stateOf(streamId);
      if (!fresh) throw streamNotFound();
      if (fresh.status === 'ENDED') throw streamEnded();
      snapshot = await this.snapshots.compose(fresh);
    } catch (error) {
      closed = true;
      await leave();
      throw error;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    connection.stopHeartbeat = this.timers.every(KEEP_ALIVE_MS, () => {
      if (!closed) res.write(': ping\n\n');
    });
    req.on('close', () => {
      if (closed) return;
      closed = true;
      connection.stopHeartbeat?.();
      void leave();
    });

    write('snapshot', {
      status: snapshot.status,
      pin: snapshot.pin,
      pinVersion: snapshot.pinVersion,
      recent: snapshot.recent,
    });
    buffering = false;
    for (const [event, data] of queue.splice(0)) {
      if (closed) break;
      write(event, data);
    }
  }
}
