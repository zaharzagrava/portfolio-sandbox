import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { compareStreamIds, GenerationBuffer, GenerationEvent, TERMINAL_EVENTS, VIEWER_TTL_MS } from '../infra/generation-buffer';

const HEARTBEAT_MS = 15_000;
const REMOTE_POLL_MS = 300;

/**
 * Writes one generation to an SSE response. Same algorithm as the topic
 * stream gateway: subscribe first (buffering live events), replay the gap
 * after Last-Event-ID from the Redis Stream, then flush the buffer skipping
 * what the replay already sent - no gap, no duplicates. A generation running
 * on another instance is followed by polling the stream.
 */
@Injectable()
export class AssistantStreamer {
  constructor(private readonly buffer: GenerationBuffer) {}

  async pipe(messageId: string, lastEventId: string | null, req: Request, res: Response): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    let cursor = lastEventId;
    let closed = false;
    const cleanups: (() => void)[] = [];
    const close = () => {
      if (closed) return;
      closed = true;
      cleanups.forEach((fn) => fn());
      res.end();
    };
    // `res` close = the client went away; `req` close only means the request body was consumed (POST).
    res.on('close', close);

    const send = (event: GenerationEvent) => {
      if (closed || (cursor && compareStreamIds(event.id, cursor) <= 0)) return;
      cursor = event.id;
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
      if (TERMINAL_EVENTS.includes(event.type)) close();
    };

    const heartbeat = setInterval(() => !closed && res.write(': ping\n\n'), HEARTBEAT_MS);
    cleanups.push(() => clearInterval(heartbeat));

    if (this.buffer.isLocal(messageId)) {
      let replaying = true;
      const pending: GenerationEvent[] = [];
      cleanups.push(this.buffer.subscribe(messageId, (e) => (replaying ? pending.push(e) : send(e))));
      for (const e of await this.buffer.replay(messageId, cursor)) send(e);
      replaying = false;
      pending.forEach(send);
      return;
    }

    // Remote (or finished) generation: replay, then poll until a terminal event; keep the remote-viewer flag alive.
    const poll = async () => {
      while (!closed) {
        await this.buffer.touchRemoteViewer(messageId).catch(() => undefined);
        for (const e of await this.buffer.replay(messageId, cursor)) send(e);
        if (!closed) await new Promise((r) => setTimeout(r, Math.min(REMOTE_POLL_MS, VIEWER_TTL_MS / 2)));
      }
    };
    void poll().catch(close);
  }
}
