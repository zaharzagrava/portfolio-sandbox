import { randomUUID } from 'node:crypto';
import http, { IncomingHttpHeaders } from 'node:http';
import { AddressInfo, Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  auctionFixture,
  batchItemOf,
  chatUnreadFixture,
  flagsFixture,
  flashSaleFixture,
  pickupFixture,
  postsFixture,
  productFixture,
  ProductFixture,
  recommendationsFixture,
  shopFixture,
  trendingFixture,
  videosFixture,
} from './fixtures';

export type RouteName =
  | 'product'
  | 'shopBatch'
  | 'productBatch'
  | 'recommendations'
  | 'trending'
  | 'flags'
  | 'chatUnread'
  | 'discussions'
  | 'videos'
  | 'pickup'
  | 'flashSale'
  | 'auction'
  | 'login'
  | 'refresh'
  | 'logout'
  | 'mfaVerify';

export interface RecordedCall {
  seq: number;
  route: RouteName | 'unknown';
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  /** `performance.now()` when the request arrived / when the answer was written (or the call was cut). */
  startedAt: number;
  endedAt?: number;
  /** The caller closed the connection before the answer was complete. */
  aborted: boolean;
  connectionId: number;
  status?: number;
  /** The request body (JSON when it parses). */
  body?: unknown;
  /** What the stub answered, for "forwarded unchanged" comparisons. */
  responseBody?: unknown;
}

export interface Behavior {
  status?: number;
  body?: unknown;
  /** A raw (non-JSON) body. */
  raw?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Waits for this promise before answering (the caller can still abort). */
  hold?: Promise<void>;
  /** Destroy the connection instead of answering. */
  reset?: boolean;
  /** Answer 302 to this location. */
  redirect?: string;
}
export type BehaviorSpec = Behavior | ((call: RecordedCall) => Behavior);

const ROUTES: [RegExp, string, RouteName][] = [
  [/^\/api\/products\/[^/]+\/recommendations$/, 'GET', 'recommendations'],
  [/^\/api\/products\/[^/]+\/videos$/, 'GET', 'videos'],
  [/^\/api\/products\/[^/]+$/, 'GET', 'product'],
  [/^\/api\/batch\/shops$/, 'GET', 'shopBatch'],
  [/^\/api\/batch\/products$/, 'GET', 'productBatch'],
  [/^\/api\/trending$/, 'GET', 'trending'],
  [/^\/api\/flags$/, 'GET', 'flags'],
  [/^\/api\/chat\/unread$/, 'GET', 'chatUnread'],
  [/^\/api\/boards\/[^/]+\/posts$/, 'GET', 'discussions'],
  [/^\/api\/pickup-points\/near$/, 'GET', 'pickup'],
  [/^\/api\/flash-sales$/, 'GET', 'flashSale'],
  [/^\/api\/auctions$/, 'GET', 'auction'],
  [/^\/api\/auth\/login$/, 'POST', 'login'],
  [/^\/api\/auth\/refresh$/, 'POST', 'refresh'],
  [/^\/api\/auth\/logout$/, 'POST', 'logout'],
  [/^\/api\/auth\/mfa\/verify$/, 'POST', 'mfaVerify'],
];

const routeOf = (method: string, path: string): RouteName | 'unknown' =>
  ROUTES.find(([re, m]) => m === method && re.test(path))?.[2] ?? 'unknown';

/** Path parameter `index` (0 = the first segment after `/api`) of a recorded call. */
export const segment = (call: RecordedCall, index: number): string =>
  call.path.split('/').filter(Boolean)[1 + index];

/**
 * A loopback HTTP server standing in for the domain APIs (S48 test plan: the network boundary is the only fake).
 * One origin serves every capability, as production has one domain-API origin; each call is recorded with its
 * route, headers, timing, connection and whether the caller cut it. Answers default to contract-valid fixtures and
 * can be replaced per route: delayed, failed, garbage, redirected, held or reset.
 */
export class StubUpstream {
  readonly calls: RecordedCall[] = [];
  connections = 0;
  readonly products = new Map<string, ProductFixture>();
  /** Shops that answer `null` in the batch (hidden, suspended, sandbox). */
  readonly hiddenShops = new Set<string>();

  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private readonly persistent = new Map<RouteName, BehaviorSpec>();
  private readonly queued = new Map<RouteName, BehaviorSpec[]>();
  private readonly pendingHolds: (() => void)[] = [];
  private readonly memo = new Map<string, Behavior>();
  private seq = 0;
  private inFlightNow = 0;
  maxInFlight = 0;

  private constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.keepAliveTimeout = 30_000;
    this.server.on('connection', (socket) => {
      this.connections++;
      this.sockets.add(socket);
      (socket as Socket & { connectionId?: number }).connectionId =
        this.connections;
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  static async start(): Promise<StubUpstream> {
    const stub = new StubUpstream();
    await new Promise<void>((resolve) =>
      stub.server.listen(0, '127.0.0.1', resolve),
    );
    return stub;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private unknownHandler?: (
    call: RecordedCall,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => void;

  /**
   * Takes over every request that matches no named route (the forwarder specs), answering on the raw response so
   * streaming and arbitrary status/headers are possible. The call is still recorded. Cleared by `reset()`.
   */
  onUnknown(handler: NonNullable<StubUpstream['unknownHandler']>): this {
    this.unknownHandler = handler;
    return this;
  }

  /** Persistent answer for a route until `reset()`. */
  respond(route: RouteName, behavior: BehaviorSpec): this {
    this.persistent.set(route, behavior);
    return this;
  }

  /** One-shot answers consumed in order, then the persistent / default answer again. */
  respondInOrder(route: RouteName, behaviors: BehaviorSpec[]): this {
    this.queued.set(route, [...behaviors]);
    return this;
  }

  /** Holds every call of a route until `release()`; held calls count as in flight. */
  hold(route: RouteName, base: Behavior = {}): { release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    this.pendingHolds.push(release);
    this.respond(route, { ...base, hold: gate });
    return { release };
  }

  callsTo(route: RouteName): RecordedCall[] {
    return this.calls.filter((c) => c.route === route);
  }

  /** Distinct connections that carried at least one call. */
  connectionsUsed(): number {
    return new Set(this.calls.map((c) => c.connectionId)).size;
  }

  get inFlight(): number {
    return this.inFlightNow;
  }

  /** Forget calls, behaviours and data; keeps the server and the connection count baseline. */
  reset(): void {
    for (const release of this.pendingHolds.splice(0)) release();
    this.calls.length = 0;
    this.persistent.clear();
    this.queued.clear();
    this.memo.clear();
    this.unknownHandler = undefined;
    this.products.clear();
    this.hiddenShops.clear();
    this.maxInFlight = 0;
  }

  async close(): Promise<void> {
    for (const release of this.pendingHolds.splice(0)) release();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private pick(call: RecordedCall): Behavior {
    if (call.route === 'unknown') return { status: 404, body: problem(404) };
    const route = call.route;
    const queue = this.queued.get(route);
    const spec = queue?.length ? queue.shift()! : this.persistent.get(route);
    if (!spec) return this.defaultFor(call);
    const behavior = typeof spec === 'function' ? spec(call) : spec;
    // a behaviour that only adds a delay or a hold keeps the default answer
    const answers =
      behavior.status !== undefined ||
      behavior.body !== undefined ||
      behavior.raw !== undefined ||
      behavior.reset ||
      behavior.redirect;
    return answers ? behavior : { ...this.defaultFor(call), ...behavior };
  }

  /** Default answers are stable per request (route, path, query), so two runs can be compared byte for byte. */
  private defaultFor(call: RecordedCall): Behavior {
    const key = `${call.route} ${call.path} ${JSON.stringify(call.query)}`;
    let behavior = this.memo.get(key);
    if (!behavior) {
      behavior = this.buildDefault(call);
      this.memo.set(key, behavior);
    }
    return { ...behavior };
  }

  private buildDefault(call: RecordedCall): Behavior {
    switch (call.route) {
      case 'product': {
        const id = segment(call, 1);
        const product = this.products.get(id);
        return product
          ? { body: product }
          : { status: 404, body: problem(404, 'product_not_found') };
      }
      case 'shopBatch': {
        const ids = (call.query.ids ?? '').split(',').filter(Boolean);
        return {
          body: ids.map((id) =>
            this.hiddenShops.has(id) ? null : shopFixture(id),
          ),
        };
      }
      case 'productBatch': {
        const ids = (call.query.ids ?? '').split(',').filter(Boolean);
        const found = ids.map((id) => this.products.get(id));
        return { body: found.map((p) => (p ? batchItemOf(p) : null)) };
      }
      case 'recommendations':
        return {
          body: recommendationsFixture([...this.products.keys()].slice(1, 3)),
        };
      case 'trending':
        return { body: trendingFixture(call.query.category) };
      case 'flags':
        return { body: flagsFixture() };
      case 'chatUnread':
        return { body: chatUnreadFixture() };
      case 'discussions':
        return { body: postsFixture() };
      case 'videos':
        return { body: videosFixture() };
      case 'pickup':
        return { body: pickupFixture() };
      case 'flashSale':
        return {
          body: (call.query.productIds ?? '')
            .split(',')
            .filter(Boolean)
            .map(flashSaleFixture),
        };
      case 'auction':
        return {
          body: (call.query.productIds ?? '')
            .split(',')
            .filter(Boolean)
            .map(auctionFixture),
        };
      default:
        return { status: 501, body: problem(501) };
    }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://stub');
    const call: RecordedCall = {
      seq: ++this.seq,
      route: routeOf(req.method ?? 'GET', url.pathname),
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      startedAt: performance.now(),
      aborted: false,
      connectionId:
        (req.socket as Socket & { connectionId?: number }).connectionId ?? 0,
    };
    this.calls.push(call);
    this.inFlightNow++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlightNow);

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      this.inFlightNow--;
      call.endedAt = performance.now();
    };
    res.on('close', () => {
      if (!res.writableFinished) call.aborted = true;
      done();
    });

    req.on('end', () => {
      if (chunks.length > 0) {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          call.body = JSON.parse(text);
        } catch {
          call.body = text;
        }
      }
      if (call.route === 'unknown' && this.unknownHandler) {
        this.unknownHandler(call, req, res);
        res.once('finish', () => (call.status = res.statusCode));
        return;
      }
      const behavior = this.pick(call);
      void this.answer(call, behavior, res, () => call.aborted);
    });
  }

  private async answer(
    call: RecordedCall,
    behavior: Behavior,
    res: http.ServerResponse,
    aborted: () => boolean,
  ): Promise<void> {
    if (behavior.hold) await behavior.hold;
    if (behavior.delayMs)
      await new Promise((r) => setTimeout(r, behavior.delayMs));
    if (aborted() || res.destroyed) return;
    if (behavior.reset) return void res.socket?.destroy();
    if (behavior.redirect) {
      call.status = 302;
      res.writeHead(302, { location: behavior.redirect }).end();
      return;
    }
    const status = behavior.status ?? 200;
    call.status = status;
    const headers: Record<string, string> = { ...behavior.headers };
    if (behavior.raw !== undefined) {
      headers['content-type'] ??= 'application/json';
      res.writeHead(status, headers).end(behavior.raw);
      return;
    }
    if (behavior.body === undefined) {
      res.writeHead(status, headers).end();
      return;
    }
    headers['content-type'] ??=
      status >= 400 ? 'application/problem+json' : 'application/json';
    call.responseBody = behavior.body;
    res.writeHead(status, headers).end(JSON.stringify(behavior.body));
  }
}

const problem = (status: number, code = 'error') => ({
  type: 'https://errors.test/' + code,
  title: 'Stub problem',
  status,
  detail: 'stub says no',
  instance: '/',
  code,
  requestId: randomUUID(),
});

/** A second origin that must never be reached (redirect targets, misconfigured sections). */
export class TripwireServer {
  readonly requests: { path: string; headers: IncomingHttpHeaders }[] = [];
  private readonly server = http.createServer((req, res) => {
    this.requests.push({ path: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });

  static async start(): Promise<TripwireServer> {
    const t = new TripwireServer();
    await new Promise<void>((r) => t.server.listen(0, '127.0.0.1', r));
    return t;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
