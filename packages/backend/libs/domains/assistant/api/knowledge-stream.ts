import type { Response } from 'express';
import type { AskSink } from '../application/ask.service';

/**
 * Binds the ask stream to an HTTP response. The headers are written by `begin()`, which the service calls only after
 * every pre-stream check and the retrieval succeeded, so each rejection before it is plain problem+json (S47 FR-032).
 */
export class HttpSseSink implements AskSink {
  closed = false;
  private readonly listeners: (() => void)[] = [];

  constructor(private readonly res: Response) {
    // `res` close = the client went away (`req` close only means the POST body was read).
    res.on('close', () => {
      this.closed = true;
      this.listeners.forEach((l) => l());
    });
  }

  begin(): void {
    this.res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }

  send(event: string, data: unknown): void {
    if (this.closed || this.res.writableEnded) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  end(): void {
    if (!this.res.writableEnded) this.res.end();
  }

  onClose(listener: () => void): void {
    this.listeners.push(listener);
  }
}
