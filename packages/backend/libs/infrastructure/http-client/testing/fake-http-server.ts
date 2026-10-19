import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { SystemClock } from '@app/common/core/clock';

const systemClock = new SystemClock();

/** One request as the fake saw it (the observable request log of the provider fakes). */
export interface LoggedRequest {
  seq: number;
  method: string;
  /** Path without the query string. */
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  rawBody: string;
  /** Parsed JSON body, `undefined` when empty or not JSON. */
  body: unknown;
  at: number;
  /** Status written back; `undefined` while in flight or when the connection was dropped. */
  status?: number;
  /** The injected fault that answered instead of the route, if any. */
  fault?: Fault['kind'];
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  /** Serialised as JSON unless `rawBody` is set. */
  json?: unknown;
  rawBody?: string;
}

export type Fault =
  /** Answers `status` with an optional JSON body instead of the route. */
  | {
      kind: 'status';
      status: number;
      headers?: Record<string, string>;
      json?: unknown;
    }
  /** `429` with `Retry-After: <seconds>` (the HTTP-date form is `retryAfterHttpDate`). */
  | {
      kind: 'rate_limit';
      retryAfterSeconds?: number;
      retryAfterHttpDate?: Date;
    }
  /** `401` with the provider's own error body. */
  | { kind: 'unauthorized' }
  /** Waits `ms` before the route answers (slow connection). */
  | { kind: 'delay'; ms: number }
  /** Destroys the socket without a response (dropped connection). */
  | { kind: 'drop' }
  /** Sends `200` with a body that is not valid JSON. */
  | { kind: 'garbage'; body?: string };

export interface FaultRule {
  /** Which requests the rule applies to; default all. */
  match?: (request: LoggedRequest) => boolean;
  fault: Fault;
  /** How many matching requests it affects; default unlimited until `clearFaults`. */
  times?: number;
}

/** A page the test holds back: `reached` resolves when a request is waiting at the gate, `release` lets it go. */
export interface Gate {
  reached: Promise<LoggedRequest>;
  release(): void;
  /** True while at least one request waits at the gate. */
  readonly waiting: boolean;
}

interface GateEntry {
  match: (request: LoggedRequest) => boolean;
  held: Promise<void>;
  release: () => void;
  onReached: (request: LoggedRequest) => void;
  waiting: number;
  once: boolean;
  consumed: boolean;
  open: boolean;
}

/**
 * Real `node:http` server on an ephemeral port with the machinery both provider fakes share: request log, fault
 * injection (status, 429 + Retry-After, 401, delay, dropped connection, garbage body) and gates that freeze a request
 * at a chosen page. Subclasses implement `route`.
 */
export abstract class FakeHttpServer {
  private server?: Server;
  private seq = 0;
  /** Stamp of `LoggedRequest.at`; a spec running on virtual time points it at that clock. */
  clockMs: () => number = () => systemClock.nowMs();
  private readonly log: LoggedRequest[] = [];
  private readonly faults: { rule: FaultRule; remaining: number }[] = [];
  private readonly gates: GateEntry[] = [];
  private readonly sockets = new Set<import('node:net').Socket>();

  /** Clock used for every `updatedAt`-style stamp; tests may replace it to freeze or advance time. */
  now: () => Date = () => systemClock.now();

  protected abstract route(request: LoggedRequest): Promise<Reply> | Reply;

  get started(): boolean {
    return this.server?.listening === true;
  }

  get port(): number {
    if (!this.server) throw new Error('fake server is not started');
    return (this.server.address() as AddressInfo).port;
  }

  private secure = false;

  /** `http://127.0.0.1:<port>` (`https` when started with `tls`); no trailing slash. */
  get baseUrl(): string {
    return `${this.secure ? 'https' : 'http'}://127.0.0.1:${this.port}`;
  }

  /**
   * Listens on an ephemeral port, or on `port` when given. With `tls` the server speaks HTTPS (the journey doubles do:
   * the stack's call stack only talks HTTPS, even to a local stand-in).
   */
  async start(
    options: { port?: number; tls?: { key: Buffer; cert: Buffer } } = {},
  ): Promise<this> {
    if (this.started) return this;
    const onRequest = (req: IncomingMessage, res: ServerResponse) => {
      void this.handle(req, res);
    };
    this.secure = options.tls !== undefined;
    const server: Server = options.tls
      ? (createHttpsServer(options.tls, onRequest) as unknown as Server)
      : createServer(onRequest);
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    for (const gate of this.gates) gate.release();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ---- request log ---------------------------------------------------------------------------------------------

  /** Every request received so far, oldest first. */
  get requests(): readonly LoggedRequest[] {
    return this.log;
  }

  requestsMatching(
    predicate: (request: LoggedRequest) => boolean,
  ): LoggedRequest[] {
    return this.log.filter(predicate);
  }

  /** Requests whose method and path match (`path` may be a string prefix or a RegExp). */
  requestsTo(method: string, path: string | RegExp): LoggedRequest[] {
    return this.log.filter(
      (r) =>
        r.method === method.toUpperCase() &&
        (typeof path === 'string'
          ? r.path.startsWith(path)
          : path.test(r.path)),
    );
  }

  clearLog(): void {
    this.log.length = 0;
  }

  // ---- faults --------------------------------------------------------------------------------------------------

  /** Registers a fault; returns a function that removes it. Drop faults in `afterEach` with `clearFaults`. */
  inject(rule: FaultRule): () => void {
    const entry = { rule, remaining: rule.times ?? Infinity };
    this.faults.push(entry);
    return () => {
      const i = this.faults.indexOf(entry);
      if (i >= 0) this.faults.splice(i, 1);
    };
  }

  clearFaults(): void {
    this.faults.length = 0;
  }

  // ---- gates ---------------------------------------------------------------------------------------------------

  /**
   * Holds every request matching `match` (default: all) before the route runs, until `release()`. With `once`, only the
   * first matching request is held. Gates are opened by `stop()` so a failed test cannot hang the suite.
   */
  gate(
    match: (request: LoggedRequest) => boolean = () => true,
    options: { once?: boolean } = {},
  ): Gate {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let onReached!: (request: LoggedRequest) => void;
    const reached = new Promise<LoggedRequest>(
      (resolve) => (onReached = resolve),
    );
    const entry: GateEntry = {
      match,
      held,
      release: () => {
        entry.open = true;
        release();
      },
      onReached,
      waiting: 0,
      once: options.once ?? false,
      consumed: false,
      open: false,
    };
    this.gates.push(entry);
    return {
      reached,
      release: entry.release,
      get waiting() {
        return entry.waiting > 0;
      },
    };
  }

  // ---- internals -----------------------------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://fake.local');
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    let body: unknown;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = undefined;
      }
    }
    const request: LoggedRequest = {
      seq: ++this.seq,
      method: (req.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query,
      headers: req.headers,
      rawBody,
      body,
      at: this.clockMs(),
    };
    this.log.push(request);

    try {
      for (const gate of this.gates) {
        if (gate.open || gate.consumed || !gate.match(request)) continue;
        gate.waiting++;
        gate.onReached(request);
        if (gate.once) gate.consumed = true;
        await gate.held;
        gate.waiting--;
        break;
      }

      const fault = this.takeFault(request);
      if (fault) {
        request.fault = fault.kind;
        if (fault.kind === 'drop') {
          req.socket.destroy();
          return;
        }
        if (fault.kind === 'delay') {
          await new Promise((r) => setTimeout(r, fault.ms));
        } else {
          this.write(res, request, this.faultReply(fault));
          return;
        }
      }

      this.write(res, request, await this.route(request));
    } catch (error) {
      if (!res.headersSent)
        this.write(res, request, {
          status: 500,
          json: { errors: String((error as Error).message) },
        });
    }
  }

  private takeFault(request: LoggedRequest): Fault | undefined {
    for (const entry of this.faults) {
      if (entry.remaining <= 0) continue;
      if (entry.rule.match && !entry.rule.match(request)) continue;
      entry.remaining--;
      return entry.rule.fault;
    }
    return undefined;
  }

  /** Provider-specific 401 body; subclasses override. */
  protected unauthorizedReply(): Reply {
    return { status: 401, json: { errors: 'Unauthorized' } };
  }

  private faultReply(fault: Exclude<Fault, { kind: 'drop' | 'delay' }>): Reply {
    switch (fault.kind) {
      case 'status':
        return {
          status: fault.status,
          headers: fault.headers,
          json: fault.json ?? { errors: 'injected' },
        };
      case 'rate_limit':
        return {
          status: 429,
          headers: {
            'retry-after': fault.retryAfterHttpDate
              ? fault.retryAfterHttpDate.toUTCString()
              : String(fault.retryAfterSeconds ?? 1),
          },
          json: { errors: 'Exceeded rate limit' },
        };
      case 'unauthorized':
        return this.unauthorizedReply();
      case 'garbage':
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          rawBody: fault.body ?? '{"products": [',
        };
    }
  }

  private write(res: ServerResponse, request: LoggedRequest, reply: Reply) {
    const payload =
      reply.rawBody ??
      (reply.json === undefined ? '' : JSON.stringify(reply.json));
    request.status = reply.status;
    res.writeHead(reply.status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      ...reply.headers,
    });
    res.end(payload);
  }
}

/** Posts a signed webhook the way a provider would (fetch to the app's webhook route). */
export async function postWebhook(
  url: string,
  headers: Record<string, string>,
  rawBody: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: rawBody,
    redirect: 'manual',
  });
  return { status: response.status, body: await response.text() };
}
