import { createHmac, randomUUID } from 'node:crypto';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { RateLimiterService } from '@app/infrastructure/rate-limit';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  startStoreProxy,
  proxyUrl,
  type TcpFaultProxy,
} from '@app/infrastructure/rate-limit/testing/fault-proxy';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import {
  IntegrationsModule,
  IntegrationsWorkerModule,
} from './integrations.module';
import { SyncEngineService } from './application/sync-engine.service';
import {
  serialiseCredentials,
  type StoredCredentials,
} from './domain/credentials';
import type { ProviderName } from './domain/normalise';
import {
  CATALOG_GATEWAY,
  CREDENTIAL_VAULT,
  INTEGRATION_REPOSITORY,
  type CredentialVault,
  type IntegrationRepository,
  type SyncMessage,
} from './domain/ports';
import {
  PROVIDER_NETWORK,
  type ProviderNetwork,
} from './infra/provider-network';
import { FakeShopify } from './test/fakes/fake-shopify';
import { FakeWooCommerce } from './test/fakes/fake-woocommerce';
import { testNetworkFor } from './test/fakes/provider-harness';
import { createStubResolver } from './test/fakes/stub-resolver';
import { TenancyFixture } from '@app/test/utils/s08-tenancy-fixture';

const APP_SECRET = 'test-shopify-app-secret-0123456789abcdef';
const SCOPES = 'read_products,read_inventory,write_inventory,read_locations';
const WOO_SECRET = 'woo-webhook-secret-for-tests';
const MIN = 60_000;
const MIB = 1024 * 1024;

const stores = new Map<string, string>();
const resolver = createStubResolver();
const network: ProviderNetwork = {
  resolver: resolver.resolve,
  unsafeTestNetwork: testNetworkFor(),
  sleep: async () => undefined,
  originFor: (target) =>
    target.provider === 'shopify' ? stores.get(target.shopDomain) : undefined,
};

const sign = (secret: string, body: string) =>
  createHmac('sha256', secret).update(body).digest('base64');

const problemCore = (b: Record<string, unknown>) => ({
  type: b.type,
  title: b.title,
  status: b.status,
  detail: b.detail,
  code: b.code,
});

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, any>;
}

/** A raw POST: nothing in the client re-serialises the body or adds a header the test did not ask for. */
async function post(
  url: string,
  headers: Record<string, string>,
  body: string,
  contentType = 'application/json',
): Promise<Reply> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': contentType, ...headers },
    body,
    redirect: 'manual',
  });
  const text = await response.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, headers: response.headers, text, json };
}

describe('Integration webhooks', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let engine: SyncEngineService;
  let integrations: IntegrationRepository;
  let vault: CredentialVault;
  let limiter: RateLimiterService;
  let redis: RedisService;
  let enqueue: jest.SpyInstance;
  let stockSpy: jest.SpyInstance;
  let baseUrl: string;
  const fakes: Array<FakeShopify | FakeWooCommerce> = [];
  const integrationIds: string[] = [];

  beforeAll(async () => {
    ctx = await createCatalogApp({
      extraImports: [IntegrationsModule, IntegrationsWorkerModule],
      overrides: [{ provide: PROVIDER_NETWORK, useValue: network }],
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    const worker = ctx.app.select(IntegrationsWorkerModule);
    engine = worker.get(SyncEngineService);
    integrations = worker.get(INTEGRATION_REPOSITORY);
    vault = worker.get(CREDENTIAL_VAULT);
    limiter = ctx.app.get(RateLimiterService);
    redis = ctx.app.get(RedisService);
    stockSpy = jest.spyOn(worker.get(CATALOG_GATEWAY), 'applyStockDelta');
    enqueue = jest
      .spyOn(ctx.app.get(TaskQueue), 'enqueue')
      .mockResolvedValue('m');
    baseUrl = await ctx.app.getUrl();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    enqueue.mockReset().mockResolvedValue('m');
    stockSpy.mockClear();
    resolver.reset();
    stores.clear();
  });

  afterEach(async () => {
    for (const f of fakes.splice(0)) await f.stop();
    await cleanup();
  });

  async function cleanup() {
    if (!integrationIds.length) return;
    const replacements = { ids: integrationIds };
    for (const table of [
      'SyncRun',
      'SyncCursor',
      'ExternalLink',
      'SyncQuarantine',
      'IntegrationHistory',
      'WebhookReceipt',
    ])
      await db.query(`DELETE FROM "${table}" WHERE "integrationId" IN (:ids)`, {
        replacements,
      });
    await db.query(`DELETE FROM "Outbox" WHERE "aggregateId" IN (:ids)`, {
      replacements,
    });
    await db.query(`DELETE FROM "Integration" WHERE "id" IN (:ids)`, {
      replacements,
    });
    integrationIds.length = 0;
  }

  // ---- helpers ------------------------------------------------------------------------------------------------

  const urlOf = (id: string) => `${baseUrl}/api/integrations/${id}/webhooks`;

  async function insertIntegration(
    provider: ProviderName,
    externalShop: string,
    credentials: StoredCredentials,
  ) {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    const id = randomUUID();
    const result = await integrations.insertConnected({
      id,
      shopId: shop.id,
      provider,
      externalShop,
      credentialsSealed: vault.seal(id, serialiseCredentials(credentials)),
      locationId: provider === 'shopify' ? '9001' : null,
      connectedBy: owner.id,
      now: ctx.clock.now(),
      maxPerShop: 5,
    });
    expect(result.kind).toBe('inserted');
    integrationIds.push(id);
    return { id, shopId: shop.id };
  }

  async function shopifyWorld() {
    const domain = `hook-${randomUUID().slice(0, 8)}.myshopify.com`;
    const fake = new FakeShopify({
      shopDomain: domain,
      pageSize: 2,
      clientSecret: APP_SECRET,
    });
    fake.now = () => ctx.clock.now();
    await fake.start();
    fakes.push(fake);
    stores.set(domain, fake.baseUrl);
    const created = await insertIntegration('shopify', domain, {
      provider: 'shopify',
      accessToken: fake.accessToken,
      scope: SCOPES,
    });
    return { ...created, fake, domain, url: urlOf(created.id) };
  }

  async function wooWorld(secret = WOO_SECRET) {
    const fake = new FakeWooCommerce();
    fake.now = () => ctx.clock.now();
    await fake.start();
    fakes.push(fake);
    const created = await insertIntegration('woocommerce', fake.baseUrl, {
      provider: 'woocommerce',
      consumerKey: fake.consumerKey,
      consumerSecret: fake.consumerSecret,
      webhookSecret: secret,
    });
    return { ...created, fake, url: urlOf(created.id) };
  }

  /** The raw request a Shopify store would send; every header can be overridden or removed. */
  function shopifyRequest(
    body: string,
    options: {
      secret?: string;
      webhookId?: string;
      topic?: string;
      triggeredAt?: Date;
      omit?: string[];
    } = {},
  ) {
    const headers: Record<string, string> = {
      'x-shopify-topic': options.topic ?? 'products/update',
      'x-shopify-hmac-sha256': sign(options.secret ?? APP_SECRET, body),
      'x-shopify-webhook-id': options.webhookId ?? `wh-${randomUUID()}`,
      'x-shopify-triggered-at': (
        options.triggeredAt ?? ctx.clock.now()
      ).toISOString(),
    };
    for (const name of options.omit ?? []) delete headers[name];
    return headers;
  }

  const receipts = (integrationId: string) =>
    db.query<{ deliveryId: string }>(
      `SELECT "deliveryId" FROM "WebhookReceipt" WHERE "integrationId" = :integrationId`,
      {
        type: QueryTypes.SELECT,
        replacements: { integrationId },
      },
    );

  const statusOf = async (id: string) =>
    (
      await db.query<Record<string, any>>(
        `SELECT "status", "credentialsSealed" FROM "Integration" WHERE "id" = :id`,
        {
          type: QueryTypes.SELECT,
          replacements: { id },
        },
      )
    )[0];

  const links = (integrationId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "ExternalLink" WHERE "integrationId" = :integrationId ORDER BY "externalId"`,
      { type: QueryTypes.SELECT, replacements: { integrationId } },
    );

  const quantities = (shopId: string) =>
    db.query<{ externalSku: string; quantity: number }>(
      `SELECT "externalSku", "quantity" FROM "Product" WHERE "shopId" = :shopId ORDER BY "externalSku"`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );

  const queued = () =>
    enqueue.mock.calls.filter(
      ([q]) => q === 'integration-sync' || q === 'integration-backfill',
    );

  const taken = (reply: Reply) => ({
    ...problemCore(reply.json),
    status: reply.status,
  });

  // ---- AS-26 ------------------------------------------------------------------------------------------------

  it('S08 AS-26: a correctly signed products/update answers 200 before any provider call, stores one receipt, enqueues one message, and the worker then fetches and applies the current state', async () => {
    const { id, shopId, fake, url } = await shopifyWorld();
    const product = fake.addProduct({ title: 'Mug', price: '19.99', stock: 5 });
    const callsBefore = fake.requests.length;

    const body = JSON.stringify({ id: product.id });
    const reply = await post(
      url,
      shopifyRequest(body, { webhookId: 'w1' }),
      body,
    );

    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ received: true });
    expect(fake.requests.length).toBe(callsBefore);
    expect((await receipts(id)).map((r) => r.deliveryId)).toEqual(['w1']);
    expect(queued()).toHaveLength(1);
    expect(queued()[0][0]).toBe('integration-sync');
    const message: SyncMessage = queued()[0][1];
    expect(message).toEqual({
      integrationId: id,
      kind: 'one',
      externalId: String(product.id),
    });
    expect(await quantities(shopId)).toHaveLength(0);

    expect(await engine.handle(message)).toBe('completed');

    expect(await quantities(shopId)).toEqual([
      expect.objectContaining({ quantity: 5 }),
    ]);
    expect(await links(id)).toHaveLength(1);
    expect(fake.requests.length).toBeGreaterThan(callsBefore);
  });

  it('S08 AS-26: inventory_levels/update enqueues one incremental pull; an unknown topic is acknowledged with nothing enqueued or recorded', async () => {
    const { id, url } = await shopifyWorld();
    const inventory = JSON.stringify({ inventory_item_id: 777, available: 3 });
    const first = await post(
      url,
      shopifyRequest(inventory, {
        topic: 'inventory_levels/update',
        webhookId: 'inv-1',
      }),
      inventory,
    );
    expect(first.status).toBe(200);
    expect(queued().map(([, m]) => m)).toEqual([
      { integrationId: id, kind: 'incremental' },
    ]);

    enqueue.mockClear();
    const other = JSON.stringify({ id: 5 });
    const ignored = await post(
      url,
      shopifyRequest(other, { topic: 'orders/create', webhookId: 'other-1' }),
      other,
    );
    expect(ignored.status).toBe(200);
    expect(queued()).toHaveLength(0);
    expect((await receipts(id)).map((r) => r.deliveryId)).toEqual(['inv-1']);
  });

  // ---- AS-27 ------------------------------------------------------------------------------------------------

  it('S08 AS-27: wrong, absent, re-serialised and foreign-secret signatures, a non-JSON body and unknown, malformed or disconnected ids all answer the identical 401 with nothing enqueued or recorded', async () => {
    const shopify = await shopifyWorld();
    const woo = await wooWorld();
    const otherWoo = await wooWorld('another-integrations-secret');
    const disconnected = await shopifyWorld();
    await integrations.transition(disconnected.id, 'ACTIVE', 'DISCONNECTED', {
      reason: 'test',
      actorId: null,
      now: ctx.clock.now(),
      eraseCredentials: true,
    });

    const compact = '{"id":1001}';
    const spaced = '{ "id": 1001 }';
    const wooHeaders = (secret: string, body: string, deliveryId: string) => ({
      'x-wc-webhook-signature': sign(secret, body),
      'x-wc-webhook-topic': 'product.updated',
      'x-wc-webhook-delivery-id': deliveryId,
    });
    const attempts: Array<[string, Promise<Reply>]> = [
      [
        'wrong secret',
        post(
          shopify.url,
          shopifyRequest(compact, {
            secret: 'not-the-secret',
            webhookId: 'a1',
          }),
          compact,
        ),
      ],
      [
        'no signature',
        post(
          shopify.url,
          shopifyRequest(compact, {
            omit: ['x-shopify-hmac-sha256'],
            webhookId: 'a2',
          }),
          compact,
        ),
      ],
      [
        'empty signature',
        post(
          shopify.url,
          {
            ...shopifyRequest(compact, { webhookId: 'a3' }),
            'x-shopify-hmac-sha256': '',
          },
          compact,
        ),
      ],
      [
        're-serialised body',
        post(shopify.url, shopifyRequest(compact, { webhookId: 'a4' }), spaced),
      ],
      [
        'not JSON, correctly signed',
        post(
          shopify.url,
          shopifyRequest('not json', { webhookId: 'a5' }),
          'not json',
        ),
      ],
      [
        'foreign integration secret (WooCommerce)',
        post(
          woo.url,
          wooHeaders('another-integrations-secret', compact, 'd-foreign'),
          compact,
        ),
      ],
      [
        'unknown id',
        post(
          urlOf(randomUUID()),
          shopifyRequest(compact, { webhookId: 'a6' }),
          compact,
        ),
      ],
      [
        'malformed id',
        post(
          urlOf('not-a-uuid'),
          shopifyRequest(compact, { webhookId: 'a7' }),
          compact,
        ),
      ],
      [
        'disconnected id',
        post(
          disconnected.url,
          shopifyRequest(compact, { webhookId: 'a8' }),
          compact,
        ),
      ],
    ];
    const replies = await Promise.all(attempts.map(([, p]) => p));

    for (const [i, reply] of replies.entries())
      expect({ case: attempts[i][0], ...taken(reply) }).toEqual({
        case: attempts[i][0],
        ...taken(replies[0]),
      });
    expect(taken(replies[0])).toMatchObject({
      status: 401,
      code: 'invalid_webhook_signature',
    });
    expect(queued()).toHaveLength(0);
    for (const w of [shopify, woo, otherWoo, disconnected])
      expect(await receipts(w.id)).toHaveLength(0);
  });

  // ---- AS-28 ------------------------------------------------------------------------------------------------

  it('S08 AS-28: the same delivery id twice, and twice at the same moment, answers 200 each time with one message and one receipt', async () => {
    const { id, url } = await shopifyWorld();
    const body = JSON.stringify({ id: 1001 });
    const send = (webhookId: string) =>
      post(url, shopifyRequest(body, { webhookId }), body);

    const sequential = [await send('dup-1'), await send('dup-1')];
    const concurrent = await Promise.all([
      send('dup-2'),
      send('dup-2'),
      send('dup-2'),
    ]);

    for (const reply of [...sequential, ...concurrent]) {
      expect(reply.status).toBe(200);
      expect(reply.json).toEqual({ received: true });
    }
    expect(queued()).toHaveLength(2);
    expect((await receipts(id)).map((r) => r.deliveryId).sort()).toEqual([
      'dup-1',
      'dup-2',
    ]);
  });

  // ---- AS-29 ------------------------------------------------------------------------------------------------

  it('S08 AS-29: a webhook triggered 5 minutes ago is accepted, 5 minutes 1 second ago is 401 webhook_stale, and WooCommerce (no timestamp) is accepted', async () => {
    const { id, url } = await shopifyWorld();
    const body = JSON.stringify({ id: 1001 });
    const now = ctx.clock.now();

    const exact = await post(
      url,
      shopifyRequest(body, {
        webhookId: 't-300',
        triggeredAt: new Date(now.getTime() - 5 * MIN),
      }),
      body,
    );
    expect(exact.status).toBe(200);
    expect(queued()).toHaveLength(1);

    const stale = await post(
      url,
      shopifyRequest(body, {
        webhookId: 't-301',
        triggeredAt: new Date(now.getTime() - 5 * MIN - 1000),
      }),
      body,
    );
    expect(taken(stale)).toMatchObject({ status: 401, code: 'webhook_stale' });
    const ancient = await post(
      url,
      shopifyRequest(body, {
        webhookId: 't-old',
        triggeredAt: new Date(now.getTime() - 60 * MIN),
      }),
      body,
    );
    expect(taken(ancient)).toMatchObject({
      status: 401,
      code: 'webhook_stale',
    });
    expect(queued()).toHaveLength(1);
    expect((await receipts(id)).map((r) => r.deliveryId)).toEqual(['t-300']);

    const woo = await wooWorld();
    const wooBody = JSON.stringify({ id: 101, parent_id: 0 });
    const wooReply = await woo.fake.deliverWebhook(
      woo.url,
      'product.updated',
      JSON.parse(wooBody),
      {
        secret: WOO_SECRET,
        deliveryId: 'woo-t',
        rawBody: wooBody,
      },
    );
    expect(wooReply.status).toBe(200);
    expect(queued()).toHaveLength(2);
  });

  // ---- AS-30 ------------------------------------------------------------------------------------------------

  it('S08 AS-30: products/delete confirmed by a 404 marks the links DELETED_AT_PROVIDER and zeroes local stock with one command, once', async () => {
    const { id, shopId, fake, url } = await shopifyWorld();
    const product = fake.addProduct({
      title: 'Mug',
      price: '19.99',
      stock: 5,
      extraVariants: [{ price: '21.50', stock: 6 }],
    });
    expect(await engine.handle({ integrationId: id, kind: 'backfill' })).toBe(
      'completed',
    );
    expect((await quantities(shopId)).map((p) => p.quantity)).toEqual([5, 6]);
    stockSpy.mockClear();
    enqueue.mockClear();

    fake.removeProduct(product.id);
    const body = JSON.stringify({ id: product.id });
    const reply = await post(
      url,
      shopifyRequest(body, { topic: 'products/delete', webhookId: 'del-1' }),
      body,
    );
    expect(reply.status).toBe(200);
    expect(queued()).toHaveLength(1);
    const message: SyncMessage = queued()[0][1];
    expect(message).toEqual({
      integrationId: id,
      kind: 'one',
      externalId: String(product.id),
    });

    expect(await engine.handle(message)).toBe('completed');

    expect((await links(id)).map((l) => l.state)).toEqual([
      'DELETED_AT_PROVIDER',
      'DELETED_AT_PROVIDER',
    ]);
    expect((await quantities(shopId)).map((p) => p.quantity)).toEqual([0, 0]);
    expect(stockSpy).toHaveBeenCalledTimes(1);
    const ops = stockSpy.mock.calls[0][0] as Array<{
      operationId: string;
      reason: string;
      delta: number;
    }>;
    expect(ops).toHaveLength(2);
    for (const op of ops) {
      expect(op.reason).toBe('sync-deleted');
      expect(op.operationId).toMatch(new RegExp(`^sync:${id}:`));
    }
    expect(ops.map((o) => o.delta).sort((a, b) => a - b)).toEqual([-6, -5]);

    // A repeat of the same message changes nothing and issues no second command.
    stockSpy.mockClear();
    expect(await engine.handle(message)).toBe('completed');
    expect(stockSpy).not.toHaveBeenCalled();
    expect((await quantities(shopId)).map((p) => p.quantity)).toEqual([0, 0]);
  });

  it('S08 AS-30: products/delete for an item the provider still returns deletes nothing', async () => {
    const { id, shopId, fake, url } = await shopifyWorld();
    const product = fake.addProduct({ title: 'Cap', price: '9', stock: 7 });
    await engine.handle({ integrationId: id, kind: 'backfill' });
    stockSpy.mockClear();
    enqueue.mockClear();

    const body = JSON.stringify({ id: product.id });
    const reply = await post(
      url,
      shopifyRequest(body, { topic: 'products/delete', webhookId: 'del-2' }),
      body,
    );
    expect(reply.status).toBe(200);
    expect(await engine.handle(queued()[0][1])).toBe('completed');

    expect((await links(id)).map((l) => l.state)).toEqual(['ACTIVE']);
    expect((await quantities(shopId)).map((p) => p.quantity)).toEqual([7]);
    expect(stockSpy).not.toHaveBeenCalled();
  });

  it('S08 AS-30: app/uninstalled disconnects the integration, erases its credentials, keeps the links and makes no further provider call', async () => {
    const { id, fake, url } = await shopifyWorld();
    fake.addProduct({ title: 'Pen', price: '3.10', stock: 10 });
    await engine.handle({ integrationId: id, kind: 'backfill' });
    const callsBefore = fake.requests.length;
    enqueue.mockClear();

    const body = JSON.stringify({ id: 1 });
    const reply = await post(
      url,
      shopifyRequest(body, { topic: 'app/uninstalled', webhookId: 'un-1' }),
      body,
    );
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ received: true });

    expect(await statusOf(id)).toEqual({
      status: 'DISCONNECTED',
      credentialsSealed: null,
    });
    const history = await db.query<Record<string, any>>(
      `SELECT * FROM "IntegrationHistory" WHERE "integrationId" = :id ORDER BY "id" DESC LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    expect(JSON.stringify(history[0])).toContain('DISCONNECTED');
    const events = await db.query<Record<string, any>>(
      `SELECT * FROM "Outbox" WHERE "aggregateId" = :id AND "type" = 'catalogsync.integration_status_changed'`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain('uninstalled');
    expect(await links(id)).toHaveLength(1);
    expect(queued()).toHaveLength(0);
    expect(
      await engine.handle({ integrationId: id, kind: 'incremental' }),
    ).toBe('ignored');
    expect(fake.requests.length).toBe(callsBefore);

    // A disconnected integration answers every later delivery (a retry included) like an unknown one, with no second event.
    expect(
      (
        await post(
          url,
          shopifyRequest(body, { topic: 'app/uninstalled', webhookId: 'un-1' }),
          body,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await post(
          url,
          shopifyRequest(body, { topic: 'app/uninstalled', webhookId: 'un-2' }),
          body,
        )
      ).status,
    ).toBe(401);
    expect(
      await db.query(
        `SELECT 1 FROM "Outbox" WHERE "aggregateId" = :id AND "type" = 'catalogsync.integration_status_changed'`,
        {
          type: QueryTypes.SELECT,
          replacements: { id },
        },
      ),
    ).toHaveLength(1);
  });

  // ---- AS-31 ------------------------------------------------------------------------------------------------

  it('S08 AS-31: when the queue call fails the answer is a generic 503 with no receipt, and the redelivery answers 200 with one message', async () => {
    const { id, url } = await shopifyWorld();
    const body = JSON.stringify({ id: 1001 });
    const headers = shopifyRequest(body, { webhookId: 'q-1' });
    enqueue.mockRejectedValueOnce(
      new Error('queue down: secret-internal-detail'),
    );

    const failed = await post(url, headers, body);

    expect(failed.status).toBe(503);
    expect(failed.text).not.toContain('secret-internal-detail');
    expect(await receipts(id)).toHaveLength(0);

    const retry = await post(url, headers, body);
    expect(retry.status).toBe(200);
    expect(retry.json).toEqual({ received: true });
    expect(await receipts(id)).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.results[1].type).toBe('return');
  });

  // ---- AS-32 ------------------------------------------------------------------------------------------------

  it('S08 AS-32: a body of 1 MiB + 1 byte is 413 and exactly 1 MiB is accepted', async () => {
    const { id, url } = await shopifyWorld();
    const padded = (bytes: number) => {
      const head = '{"id":1001,"pad":"';
      const tail = '"}';
      return head + 'x'.repeat(bytes - head.length - tail.length) + tail;
    };

    const over = padded(MIB + 1);
    expect(Buffer.byteLength(over)).toBe(MIB + 1);
    const refused = await post(
      url,
      shopifyRequest(over, { webhookId: 'big-1' }),
      over,
    );
    expect(refused.status).toBe(413);
    expect(await receipts(id)).toHaveLength(0);
    expect(queued()).toHaveLength(0);

    const exact = padded(MIB);
    expect(Buffer.byteLength(exact)).toBe(MIB);
    expect(
      (await post(url, shopifyRequest(exact, { webhookId: 'big-2' }), exact))
        .status,
    ).toBe(200);
  });

  it('S08 AS-32: the 1,201st request of a minute for one integration is 429 with Retry-After, the others are not affected', async () => {
    const one = await shopifyWorld();
    const two = await shopifyWorld();
    const body = JSON.stringify({ id: 1001 });
    // The window already holds 1,200 requests of this integration (the policy's limit): the next one is the 1,201st.
    const filled = await limiter.check(
      'catalog-sync.webhook.integration',
      `custom:${one.id}`,
      1200,
    );
    expect(filled.allowed).toBe(true);

    const refused = await post(
      one.url,
      shopifyRequest(body, { webhookId: 'rl-1' }),
      body,
    );
    expect(refused.status).toBe(429);
    expect(refused.json.code).toBe('rate_limited');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await receipts(one.id)).toHaveLength(0);

    expect(
      (await post(two.url, shopifyRequest(body, { webhookId: 'rl-2' }), body))
        .status,
    ).toBe(200);
  });

  it('S08 AS-32: the 601st request of a minute from one address is 429 with Retry-After before the signature is looked at; 600 are not refused', async () => {
    const ipKeys = () => redis.client.keys('rl:{catalog-sync.webhook.ip|*');
    const clear = async () => {
      const keys = await ipKeys();
      if (keys.length) await redis.client.del(...keys);
    };
    await clear();
    try {
      const { url } = await shopifyWorld();
      const body = JSON.stringify({ id: 1001 });
      const statuses: number[] = [];
      for (let batch = 0; batch < 12; batch++)
        statuses.push(
          ...(await Promise.all(
            Array.from({ length: 50 }, (_, i) =>
              post(
                url,
                shopifyRequest(body, {
                  secret: 'forged',
                  webhookId: `ip-${batch}-${i}`,
                }),
                body,
              ).then((r) => r.status),
            ),
          )),
        );
      expect(statuses.every((s) => s === 401)).toBe(true);

      const refused = await post(
        url,
        shopifyRequest(body, { webhookId: 'ip-601' }),
        body,
      );
      expect(refused.status).toBe(429);
      expect(refused.json.code).toBe('rate_limited');
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(queued()).toHaveLength(0);
    } finally {
      await clear();
    }
  });

  // ---- AS-33 ------------------------------------------------------------------------------------------------

  it('S08 AS-33: a WooCommerce delivery with a correct base64 signature is accepted once per delivery id; the registration ping and a wrong signature are handled', async () => {
    const { id, fake, url } = await wooWorld();

    const first = await fake.deliverWebhook(
      url,
      'product.updated',
      { id: 101, parent_id: 0 },
      { secret: WOO_SECRET, deliveryId: 'wd-1' },
    );
    const again = await fake.deliverWebhook(
      url,
      'product.updated',
      { id: 101, parent_id: 0 },
      { secret: WOO_SECRET, deliveryId: 'wd-1' },
    );
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(queued().map(([, m]) => m)).toEqual([
      { integrationId: id, kind: 'one', externalId: '101' },
    ]);
    expect((await receipts(id)).map((r) => r.deliveryId)).toEqual(['wd-1']);

    const variation = await fake.deliverWebhook(
      url,
      'product.updated',
      { id: 205, parent_id: 200 },
      { secret: WOO_SECRET, deliveryId: 'wd-2' },
    );
    expect(variation.status).toBe(200);
    expect(queued()[1][1]).toEqual({
      integrationId: id,
      kind: 'one',
      externalId: '200:205',
    });

    enqueue.mockClear();
    const pingBody = 'webhook_id=42';
    const ping = await post(
      url,
      { 'x-wc-webhook-signature': sign(WOO_SECRET, pingBody) },
      pingBody,
      'application/x-www-form-urlencoded',
    );
    expect(ping.status).toBe(200);
    expect(queued()).toHaveLength(0);
    expect((await receipts(id)).map((r) => r.deliveryId).sort()).toEqual([
      'wd-1',
      'wd-2',
    ]);

    const forged = await fake.deliverWebhook(
      url,
      'product.updated',
      { id: 101, parent_id: 0 },
      { secret: 'wrong', deliveryId: 'wd-3' },
    );
    expect(forged.status).toBe(401);
    expect(JSON.parse(forged.body).code).toBe('invalid_webhook_signature');
    const forgedPing = await post(
      url,
      { 'x-wc-webhook-signature': sign('wrong', pingBody) },
      pingBody,
      'application/x-www-form-urlencoded',
    );
    expect(forgedPing.status).toBe(401);
    expect(queued()).toHaveLength(0);
  });

  // ---- AS-34 ------------------------------------------------------------------------------------------------

  it.each(['PAUSED', 'NEEDS_REAUTH'] as const)(
    'S08 AS-34: a valid webhook for a %s integration answers 200 and enqueues and records nothing',
    async (status) => {
      const { id, url } = await shopifyWorld();
      const moved = await integrations.transition(id, 'ACTIVE', status, {
        reason: 'test',
        actorId: null,
        now: ctx.clock.now(),
        pausedReason: status === 'PAUSED' ? 'seller' : null,
      });
      expect(moved?.status).toBe(status);
      const body = JSON.stringify({ id: 1001 });

      const reply = await post(
        url,
        shopifyRequest(body, { webhookId: 'p-1' }),
        body,
      );
      expect(reply.status).toBe(200);
      expect(reply.json).toEqual({ received: true });
      expect(queued()).toHaveLength(0);
      expect(await receipts(id)).toHaveLength(0);

      const forged = await post(
        url,
        shopifyRequest(body, { secret: 'forged', webhookId: 'p-2' }),
        body,
      );
      expect(forged.status).toBe(401);
    },
  );
});

describe('Integration webhooks with the limiter store down', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let proxy: TcpFaultProxy;
  let enqueue: jest.SpyInstance;
  let integrationId: string;
  let baseUrl: string;

  beforeAll(async () => {
    proxy = await startStoreProxy();
    ctx = await createCatalogApp({
      extraImports: [IntegrationsModule, IntegrationsWorkerModule],
      overrides: [{ provide: PROVIDER_NETWORK, useValue: network }],
      redisUrl: proxyUrl(proxy),
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    enqueue = jest
      .spyOn(ctx.app.get(TaskQueue), 'enqueue')
      .mockResolvedValue('m');
    baseUrl = await ctx.app.getUrl();
    const worker = ctx.app.select(IntegrationsWorkerModule);
    const repo: IntegrationRepository = worker.get(INTEGRATION_REPOSITORY);
    const vault: CredentialVault = worker.get(CREDENTIAL_VAULT);
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    integrationId = randomUUID();
    await repo.insertConnected({
      id: integrationId,
      shopId: shop.id,
      provider: 'shopify',
      externalShop: `down-${integrationId.slice(0, 8)}.myshopify.com`,
      credentialsSealed: vault.seal(
        integrationId,
        serialiseCredentials({
          provider: 'shopify',
          accessToken: 'tok',
          scope: SCOPES,
        }),
      ),
      locationId: '9001',
      connectedBy: owner.id,
      now: ctx.clock.now(),
      maxPerShop: 5,
    });
  });

  afterAll(async () => {
    proxy.mode = 'pass';
    const replacements = { ids: [integrationId] };
    for (const table of ['IntegrationHistory', 'WebhookReceipt', 'SyncCursor'])
      await db.query(`DELETE FROM "${table}" WHERE "integrationId" IN (:ids)`, {
        replacements,
      });
    await db.query(`DELETE FROM "Outbox" WHERE "aggregateId" IN (:ids)`, {
      replacements,
    });
    await db.query(`DELETE FROM "Integration" WHERE "id" IN (:ids)`, {
      replacements,
    });
    await ctx.close();
    await proxy.close();
  });

  it('S08 AS-32: with the limiter store stopped a correctly signed webhook is still accepted and a forged one is still refused', async () => {
    proxy.mode = 'refuse';
    proxy.sever();
    const url = `${baseUrl}/api/integrations/${integrationId}/webhooks`;
    const body = JSON.stringify({ id: 1001 });
    const headers = (secret: string, webhookId: string) => ({
      'x-shopify-topic': 'products/update',
      'x-shopify-hmac-sha256': sign(secret, body),
      'x-shopify-webhook-id': webhookId,
      'x-shopify-triggered-at': ctx.clock.now().toISOString(),
    });

    const accepted = await post(url, headers(APP_SECRET, 'down-1'), body);
    const forged = await post(url, headers('forged', 'down-2'), body);

    expect(accepted.status).toBe(200);
    expect(accepted.json).toEqual({ received: true });
    expect(
      enqueue.mock.calls.filter(([q]) => q === 'integration-sync'),
    ).toHaveLength(1);
    expect(forged.status).toBe(401);
  }, 60_000);
});
