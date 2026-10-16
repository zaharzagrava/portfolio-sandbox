import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface EdgeRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  at: number;
}

/**
 * A real HTTP server on a random local port standing in for an outside service (the CDN's API, the front end's
 * revalidation route): the code under test makes its real calls, the spec scripts the answers and reads what arrived.
 * `script` is a queue of statuses for the next requests (an empty queue answers `defaultStatus`).
 */
export class FakeEdge {
  readonly requests: EdgeRequest[] = [];
  /** Statuses for the next requests, consumed in order; after that the default answer. */
  script: number[] = [];
  /** Answer for every request once the script is empty. */
  defaultStatus = 200;
  /** Milliseconds each request waits before answering (timeout tests). */
  delayMs = 0;
  /** Runs when a request has arrived, before the answer (order and state-at-arrival checks). */
  onRequest: ((request: EdgeRequest) => void | Promise<void>) | undefined;
  private server: http.Server | undefined;
  url = '';

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const request: EdgeRequest = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          at: Date.now(),
        };
        this.requests.push(request);
        const status = this.script.shift() ?? this.defaultStatus;
        void Promise.resolve(this.onRequest?.(request)).then(() =>
          this.answer(res, status),
        );
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, '127.0.0.1', resolve),
    );
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  private answer(res: http.ServerResponse, status: number): void {
    setTimeout(() => {
      if (res.destroyed) return;
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          status < 300 ? { success: true } : { success: false, errors: [] },
        ),
      );
    }, this.delayMs);
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  reset(): void {
    this.requests.length = 0;
    this.script = [];
    this.defaultStatus = 200;
    this.delayMs = 0;
    this.onRequest = undefined;
  }

  /** The JSON bodies received, in order. */
  bodies<T = unknown>(): T[] {
    return this.requests.map((r) => JSON.parse(r.body) as T);
  }
}
