import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import supertest from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import {
  eventEnvelopeSchema,
  productEventSchemas,
  webhookOrderEventSchemas,
  webhookPayoutEventSchemas,
  webhookShopDeletedSchema,
  webhookMessageSchema,
  type WebhookMessage,
} from '@marketplace-sandbox/contracts';
import { FakeClock } from '@app/common/core/clock';
import { startStandIn, type StandIn } from '@app/test/toolkit/stand-in-server';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import { addMember, createShop } from '@app/test/utils/tenancy-fixtures';
import { RandomSource } from '../domain/webhook-ports';
import {
  WEBHOOK_NET_OPTIONS,
  type WebhookNetOptions,
} from '../infra/safe-outbound-http.adapter';
import { WebhooksModule } from '../webhooks.module';

/**
 * Shared fixture of the S43 end-to-end specs (test-plan.md). Everything except the system edge is real: Postgres, Redis,
 * the delivery log store, the queue stand-in and the Nest modules. The only fakes are the ones the plan names: the
 * resolver, the receiver's server, the clock and the jitter source. Shops, users and memberships come through the shared
 * seeding helpers of `@app/test/utils` (the same ones every capability uses); no spec of this capability injects a model
 * of another domain (D-7). Every spec creates its own shops, endpoints, receivers and events (L-005, L-006).
 */

// ---------------------------------------------------------------- time and waiting

/** The instant every spec of this capability starts from: time moves only through `clock.advance` and `clock.set`. */
export const FROZEN_NOW = new Date('2026-10-06T12:00:00.000Z');

/** Polls `condition` until it returns something truthy (no fixed sleeps, L-007); fails with `label` after `timeoutMs`. */
export async function waitFor<T>(
  condition: () =>
    Promise<T | false | undefined | null> | T | false | undefined | null,
  label: string,
  timeoutMs = Number(process.env.PW_EXPECT_TIMEOUT_MS ?? 10_000),
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Jitter source with a value the spec sets (0 and 1 are the bounds of the schedule). */
export class FixedRandom extends RandomSource {
  value = 0.5;
  next(): number {
    return this.value;
  }
}

// ---------------------------------------------------------------- resolver

/** Injected DNS: host name -> addresses. Unknown names answer ENOTFOUND (`unresolvable`). */
export class FakeResolver {
  private readonly table = new Map<string, string[]>();
  readonly lookups: string[] = [];

  private readonly scripts = new Map<string, string[][]>();

  set(host: string, addresses: string[]): void {
    this.scripts.delete(host.toLowerCase());
    this.table.set(host.toLowerCase(), addresses);
  }

  /** Answers one list per lookup, in turn (the last one repeats): a DNS answer that changes between two lookups. */
  sequence(host: string, ...answers: string[][]): void {
    this.scripts.set(host.toLowerCase(), [...answers]);
  }

  delete(host: string): void {
    this.scripts.delete(host.toLowerCase());
    this.table.delete(host.toLowerCase());
  }

  /** Number of lookups of one host so far. */
  lookupsOf(host: string): number {
    return this.lookups.filter((h) => h.toLowerCase() === host.toLowerCase())
      .length;
  }

  readonly resolve = (
    host: string,
  ): Promise<{ address: string; family: 4 | 6 }[]> => {
    this.lookups.push(host);
    const script = this.scripts.get(host.toLowerCase());
    const addresses = script
      ? script.length > 1
        ? script.shift()
        : script[0]
      : this.table.get(host.toLowerCase());
    if (!addresses)
      return Promise.reject(
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
          code: 'ENOTFOUND',
        }),
      );
    return Promise.resolve(
      addresses.map((address) => ({
        address,
        family: address.includes(':') ? (6 as const) : (4 as const),
      })),
    );
  };
}

// ---------------------------------------------------------------- receiver

export type ReceiverStep =
  /** Answers `status` (default 200), optionally after `delayMs`. */
  | {
      status?: number;
      headers?: Record<string, string>;
      body?: string;
      delayMs?: number;
    }
  /** Accepts the request and never answers. */
  | { hang: true }
  /** Answers 200 headers, then one byte every `intervalMs` (default 1000) forever. */
  | { slowDrip: true; intervalMs?: number }
  /** Answers 200 with `bytes` of body. */
  | { bigBody: number }
  /** Answers a redirect to `location`. */
  | { redirect: string; status?: 301 | 302 | 307 | 308 }
  /** Accepts the request and resets the connection. */
  | { reset: true };

export interface ReceivedRequest {
  at: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** The raw body exactly as received (the signature is checked over these bytes). */
  body: string;
  eventId?: string;
  deliveryId?: string;
  eventType?: string;
  attempt?: number;
  replay: boolean;
  signature?: string;
}

let nextAddress = 1;
/** A public address per receiver (documentation ranges are blocked by the guard, so this is an ordinary public /24). */
const publicAddress = () =>
  `93.184.${216 + Math.floor(nextAddress / 250)}.${(nextAddress++ % 250) + 1}`;

/**
 * A real local HTTPS server standing in for a shop's receiver: a status script, hang, slow-drip, redirect, big body, and
 * a recorder of arrivals with the highest number of requests in flight at once (single flight per endpoint, AS-36).
 */
export class WebhookReceiver {
  readonly requests: ReceivedRequest[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private steps: ReceiverStep[] = [{ status: 200 }];
  private cursor = 0;
  private timers = new Set<NodeJS.Timeout>();

  private constructor(
    private readonly standIn: StandIn,
    readonly host: string,
    readonly address: string,
  ) {
    standIn.setHandler((req, res, recorded) => {
      const headers = Object.fromEntries(
        Object.entries(recorded.headers).map(([k, v]) => [k, String(v)]),
      );
      this.requests.push({
        at: recorded.at,
        method: recorded.method,
        path: recorded.url,
        headers,
        body: recorded.body.toString('utf8'),
        eventId: headers['marketplace-event-id'],
        deliveryId: headers['marketplace-delivery-id'],
        eventType: headers['marketplace-event-type'],
        attempt: headers['marketplace-attempt']
          ? Number(headers['marketplace-attempt'])
          : undefined,
        replay: headers['marketplace-replay'] === '1',
        signature: headers['marketplace-signature'],
      });
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      res.on('close', () => this.inFlight--);
      const step = this.steps[Math.min(this.cursor++, this.steps.length - 1)];
      if ('hang' in step) return;
      if ('reset' in step) {
        req.socket.destroy();
        return;
      }
      if ('slowDrip' in step) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        const timer = setInterval(
          () => res.write('.'),
          step.intervalMs ?? 1000,
        );
        this.timers.add(timer);
        res.on('close', () => {
          clearInterval(timer);
          this.timers.delete(timer);
        });
        return;
      }
      if ('bigBody' in step) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(Buffer.alloc(step.bigBody, 'x'));
        return;
      }
      if ('redirect' in step) {
        res.writeHead(step.status ?? 301, { location: step.redirect }).end();
        return;
      }
      const answer = () =>
        res
          .writeHead(step.status ?? 200, step.headers ?? {})
          .end(step.body ?? '');
      if (step.delayMs) {
        const timer = setTimeout(answer, step.delayMs);
        this.timers.add(timer);
      } else answer();
    });
  }

  /** `host` must resolve (through the fake resolver) to this receiver's own public address. */
  static async start(
    options: { host?: string } = {},
  ): Promise<WebhookReceiver> {
    const host = options.host ?? `hooks-${uuidv7().slice(-12)}.acme.test`;
    const standIn = await startStandIn({ tlsHosts: [host] });
    return new WebhookReceiver(standIn, host, publicAddress());
  }

  get port(): number {
    return this.standIn.port;
  }

  get ca(): string {
    return this.standIn.ca!;
  }

  /** TCP connections accepted so far (a blocked attempt must leave this unchanged). */
  get connections(): number {
    return this.standIn.connections;
  }

  url(path = '/in'): string {
    return `https://${this.host}${path}`;
  }

  /** The answers, in turn; the last one repeats. */
  respondWith(...steps: ReceiverStep[]): this {
    this.steps = steps.length ? steps : [{ status: 200 }];
    this.cursor = 0;
    return this;
  }

  clear(): void {
    this.requests.length = 0;
    this.inFlight = 0;
    this.maxInFlight = 0;
    this.cursor = 0;
  }

  async close(): Promise<void> {
    for (const timer of this.timers) {
      clearInterval(timer);
      clearTimeout(timer);
    }
    this.timers.clear();
    await this.standIn.close();
  }
}

/**
 * The options of the outbound call for a set of receivers: the injected resolver, the CA of every stand-in and the map
 * from each receiver's public address to its local port. Read lazily, so receivers started later are included.
 */
export function netOptionsFor(
  resolver: FakeResolver,
  receivers: () => WebhookReceiver[],
): WebhookNetOptions {
  return {
    resolver: resolver.resolve,
    get testTransport() {
      const list = receivers();
      return {
        ca: list.map((r) => r.ca).join('\n'),
        mapAddress: (address: string, port: number) => {
          const hit = list.find((r) => r.address === address);
          return hit
            ? { address: '127.0.0.1', port: hit.port }
            : { address, port };
        },
      };
    },
  } as WebhookNetOptions;
}

// ---------------------------------------------------------------- source events (schema-valid envelopes)

export interface SourceEvent {
  eventId: string;
  type: string;
  version: number;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export function envelope(
  type: string,
  aggregateId: string,
  payload: Record<string, unknown>,
  options: {
    occurredAt?: Date;
    aggregateVersion?: number;
    eventId?: string;
  } = {},
): SourceEvent {
  return eventEnvelopeSchema.parse({
    eventId: options.eventId ?? uuidv7(),
    type,
    version: 1,
    aggregateType: type.split('.')[0],
    aggregateId,
    aggregateVersion: options.aggregateVersion ?? 1,
    occurredAt: (options.occurredAt ?? FROZEN_NOW).toISOString(),
    payload,
  }) as SourceEvent;
}

export interface OrderLineSeed {
  productId?: string;
  title?: string;
  quantity?: number;
  unitPriceMinor?: number;
}

/** `order.paid` for the given shops: each shop's lines and subtotal, validated against the contract schema. */
export function orderPaidEvent(input: {
  orderId?: string;
  userId?: string;
  currency?: string;
  orderVersion?: number;
  shops: { shopId: string; lines?: OrderLineSeed[] }[];
  occurredAt?: Date;
}): SourceEvent {
  const orderId = input.orderId ?? uuidv7();
  const currency = input.currency ?? 'EUR';
  const lines = input.shops.flatMap(({ shopId, lines: seeds }) =>
    (seeds ?? [{}]).map((seed, i) => {
      const quantity = seed.quantity ?? 1;
      const unitPriceMinor = seed.unitPriceMinor ?? 1000;
      return {
        productId: seed.productId ?? uuidv7(),
        shopId,
        title: seed.title ?? `Product ${i + 1}`,
        quantity,
        unitPriceMinor,
        discountMinor: 0,
        lineTotalMinor: quantity * unitPriceMinor,
      };
    }),
  );
  const payload = webhookOrderEventSchemas['order.paid'].parse({
    orderId,
    userId: input.userId ?? uuidv7(),
    orderVersion: input.orderVersion ?? 1,
    totalMinor: lines.reduce((s, l) => s + l.lineTotalMinor, 0),
    currency,
    paymentRef: `pay_${uuidv7().slice(-8)}`,
    paidAt: (input.occurredAt ?? FROZEN_NOW).toISOString(),
    lines,
    shopOrders: input.shops.map(({ shopId }) => ({
      shopOrderId: uuidv7(),
      shopId,
      subtotalMinor: lines
        .filter((l) => l.shopId === shopId)
        .reduce((s, l) => s + l.lineTotalMinor, 0),
    })),
  });
  return envelope('order.paid', orderId, payload, {
    occurredAt: input.occurredAt,
    aggregateVersion: payload.orderVersion,
  });
}

/** `order.cancelled` / `order.refunded`; `shopIds` is omitted when `shopIds` is undefined (the S10 fallback case). */
export function orderStatusEvent(
  type: 'order.cancelled' | 'order.refunded',
  input: {
    orderId?: string;
    shopIds?: string[];
    orderVersion?: number;
    occurredAt?: Date;
  },
): SourceEvent {
  const orderId = input.orderId ?? uuidv7();
  const base = {
    orderId,
    userId: uuidv7(),
    orderVersion: input.orderVersion ?? 2,
    ...(input.shopIds ? { shopIds: input.shopIds } : {}),
  };
  const payload =
    type === 'order.cancelled'
      ? webhookOrderEventSchemas['order.cancelled'].parse({
          ...base,
          reason: 'payment_failed',
          previousStatus: 'RESERVED',
        })
      : webhookOrderEventSchemas['order.refunded'].parse({
          ...base,
          amountMinor: 1000,
          currency: 'EUR',
          reason: 'requested_by_customer',
        });
  return envelope(type, orderId, payload, {
    occurredAt: input.occurredAt,
    aggregateVersion: base.orderVersion,
  });
}

/** A full-state `catalog.product_*` snapshot (S05); `deleted` carries the tombstone payload. */
export function productEvent(
  kind: 'created' | 'updated' | 'archived' | 'restored' | 'deleted',
  input: {
    shopId: string;
    productId?: string;
    title?: string;
    priceMinor?: number;
    quantity?: number;
    changedFields?: string[];
    isSandbox?: boolean;
    productVersion?: number;
    occurredAt?: Date;
  },
): SourceEvent {
  const productId = input.productId ?? uuidv7();
  const productVersion = input.productVersion ?? 1;
  const type = `catalog.product_${kind}` as keyof typeof productEventSchemas;
  const payload =
    kind === 'deleted'
      ? productEventSchemas['catalog.product_deleted'].parse({
          productId,
          shopId: input.shopId,
          productVersion,
        })
      : productEventSchemas[type].parse({
          productId,
          shopId: input.shopId,
          title: input.title ?? 'Blue mug',
          description: 'd',
          brand: 'b',
          category: 'c',
          priceMinor: input.priceMinor ?? 1250,
          currency: 'EUR',
          rating: 0,
          tags: [],
          quantity: input.quantity ?? 10,
          inStock: (input.quantity ?? 10) > 0,
          status: kind === 'archived' ? 'ARCHIVED' : 'ACTIVE',
          isSandbox: input.isSandbox ?? false,
          externalSku: null,
          productVersion,
          createdAt: FROZEN_NOW.toISOString(),
          updatedAt: FROZEN_NOW.toISOString(),
          changedFields: input.changedFields ?? ['title'],
        });
  return envelope(type, productId, payload as Record<string, unknown>, {
    occurredAt: input.occurredAt,
    aggregateVersion: productVersion,
  });
}

export function payoutEvent(
  kind: 'paid' | 'failed',
  input: {
    shopId: string;
    payoutId?: string;
    payoutVersion?: number;
    amountMinor?: number;
    occurredAt?: Date;
  },
): SourceEvent {
  const payoutId = input.payoutId ?? uuidv7();
  const payoutVersion = input.payoutVersion ?? 1;
  const base = {
    payoutId,
    shopId: input.shopId,
    periodStart: '2026-09-01',
    amountMinor: input.amountMinor ?? 123_456,
    currency: 'EUR',
    payoutVersion,
  };
  const payload =
    kind === 'paid'
      ? webhookPayoutEventSchemas['payout.paid'].parse({
          ...base,
          transferRef: 'tr_1',
          paidAt: FROZEN_NOW.toISOString(),
        })
      : webhookPayoutEventSchemas['payout.failed'].parse({
          ...base,
          failureCode: 'account_closed',
        });
  return envelope(`payout.${kind}`, payoutId, payload, {
    occurredAt: input.occurredAt,
    aggregateVersion: payoutVersion,
  });
}

export function shopDeletedEvent(shopId: string, shopVersion = 3): SourceEvent {
  return envelope(
    'tenancy.shop_deleted',
    shopId,
    webhookShopDeletedSchema.parse({ shopId, shopVersion }),
    { aggregateVersion: shopVersion },
  );
}

/** The JSON a receiver got, parsed with the contract schema (throws if it does not conform). */
export const parseReceived = (request: ReceivedRequest): WebhookMessage =>
  webhookMessageSchema.parse(JSON.parse(request.body));

// ---------------------------------------------------------------- the kit

export interface WebhookWorld {
  /** OWNER of the shop. */
  owner: TestUser;
  /** ADMIN: has `webhooks.manage` too. */
  admin: TestUser;
  /** STAFF and VIEWER: no `webhooks.manage` (403 on every route). */
  staff: TestUser;
  viewer: TestUser;
  /** A user who is a member of no shop of this world (a non-member gets 404). */
  outsider: TestUser;
  shop: { id: string };
}

export interface WebhookKit extends CatalogTestApp {
  clock: FakeClock;
  resolver: FakeResolver;
  random: FixedRandom;
  receivers: WebhookReceiver[];
  /** Starts a receiver whose host resolves (through the fake resolver) to its own public address. */
  startReceiver(options?: { host?: string }): Promise<WebhookReceiver>;
  /** A fresh shop with its members (L-005, L-006: every spec creates its own world); live unless `status` says otherwise. */
  seedWorld(options?: {
    status?: 'ACTIVE' | 'SUSPENDED' | 'DELETING';
  }): Promise<WebhookWorld>;
  /** A new address no other endpoint of any spec uses; its host resolves (fake resolver) to a public address. */
  endpointUrl(path?: string): string;
  /** `/api/shops/:shopId/developers/webhooks` for a world. */
  base(world: { shop: { id: string } }): string;
  /** Rows of a table for assertions (test code may read every table, IX.6). */
  rows<T extends object>(
    sql: string,
    replacements?: Record<string, unknown>,
  ): Promise<T[]>;
  exec(sql: string, replacements?: Record<string, unknown>): Promise<void>;
  /** The events committed to the outbox (payload, not the envelope), oldest first. */
  outboxEvents(
    eventName: string,
    filter?: { aggregateId?: string },
  ): Promise<{ eventName: string; aggregateId: string; payload: any }[]>;
  /** Captured stdout of the structured logger (only with `structuredLogger: true`). */
  rawLogs(): string;
}

/**
 * The dashboard application of the capability (`WebhooksModule`, prefix `/api`, real sessions and tenancy) with the
 * fakes of the plan: clock, resolver, receivers' stand-ins and the jitter source. `extraImports` adds the worker,
 * projector or Lambda host modules a spec exercises.
 */
export async function createWebhookKit(
  options: {
    extraImports?: unknown[];
    overrides?: Array<{ provide: unknown; useValue: unknown }>;
    env?: Record<string, string>;
    /** Run the production JSON logger and capture its stdout (`rawLogs()`). */
    structuredLogger?: boolean;
  } = {},
): Promise<WebhookKit> {
  const resolver = new FakeResolver();
  const random = new FixedRandom();
  const receivers: WebhookReceiver[] = [];
  const net = netOptionsFor(resolver, () => receivers);
  const logChunks: string[] = [];
  const stdoutSpy = options.structuredLogger
    ? jest
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: unknown) => {
          logChunks.push(String(chunk));
          return true;
        })
    : null;
  const base = await createCatalogApp({
    extraImports: [WebhooksModule, ...(options.extraImports ?? [])],
    overrides: [
      { provide: WEBHOOK_NET_OPTIONS, useValue: net },
      { provide: RandomSource, useValue: random },
      ...(options.overrides ?? []),
    ],
    env: options.env,
    structuredLogger: options.structuredLogger,
  });
  base.clock.set(FROZEN_NOW);
  const db = (): Sequelize => base.app.get(Sequelize);

  const kit: WebhookKit = {
    ...base,
    resolver,
    random,
    receivers,
    async startReceiver(opts) {
      const receiver = await WebhookReceiver.start(opts);
      receivers.push(receiver);
      resolver.set(receiver.host, [receiver.address]);
      return receiver;
    },
    endpointUrl(path = '/in') {
      const host = `hooks-${uuidv7().slice(-12)}.acme.test`;
      resolver.set(host, ['93.184.216.34']);
      return `https://${host}${path}`;
    },
    async seedWorld(opts = {}) {
      // the five people are independent rows, so they are made at the same time
      const [owner, admin, staff, viewer, outsider] = await Promise.all([
        base.newUser(),
        base.newUser(),
        base.newUser(),
        base.newUser(),
        base.newUser(),
      ]);
      const shop = await createShop(base.app, owner, { status: opts.status });
      await Promise.all([
        addMember(base.app, shop.id, admin.id, 'ADMIN'),
        addMember(base.app, shop.id, staff.id, 'STAFF'),
        addMember(base.app, shop.id, viewer.id, 'VIEWER'),
      ]);
      return {
        owner,
        admin,
        staff,
        viewer,
        outsider,
        shop: { id: shop.id },
      };
    },
    base: (world) => `/api/shops/${world.shop.id}/developers/webhooks`,
    rows: (sql, replacements = {}) =>
      db().query(sql, { type: QueryTypes.SELECT, replacements }) as never,
    async exec(sql, replacements = {}) {
      await db().query(sql, { replacements });
    },
    outboxEvents: (eventName, filter = {}) =>
      kit.rows(
        `SELECT "eventName", "aggregateId", payload->'payload' AS payload
           FROM "Outbox"
          WHERE "eventName" = :eventName
            AND (CAST(:aggregateId AS text) IS NULL OR "aggregateId" = :aggregateId)
          ORDER BY "createdAt", id`,
        { eventName, aggregateId: filter.aggregateId ?? null },
      ),
    async reset() {
      await base.reset();
      base.clock.set(FROZEN_NOW);
      random.value = 0.5;
    },
    rawLogs: () => logChunks.join(''),
    async close() {
      stdoutSpy?.mockRestore();
      await Promise.all(receivers.map((r) => r.close()));
      await base.close();
    },
  };
  return kit;
}

export type { INestApplication, TestUser };
export const agent = (app: INestApplication) => supertest(app.getHttpServer());
