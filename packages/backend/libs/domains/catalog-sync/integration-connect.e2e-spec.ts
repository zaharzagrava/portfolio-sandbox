import { createHmac, randomUUID } from 'node:crypto';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import {
  integrationInstallResponseSchema,
  integrationSchema,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { SecretBox } from '@app/domains/identity';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import { IntegrationsModule } from './integrations.module';
import {
  PROVIDER_NETWORK,
  type ProviderNetwork,
} from './infra/provider-network';
import { FakeShopify } from './test/fakes/fake-shopify';
import { FakeWooCommerce } from './test/fakes/fake-woocommerce';
import {
  createStubResolver,
  PRIVATE_ADDRESSES,
  PUBLIC_ADDRESS,
} from './test/fakes/stub-resolver';
import { testNetworkFor } from './test/fakes/provider-harness';
import { TenancyFixture } from '@app/test/utils/s08-tenancy-fixture';

const APP_KEY = 'test-shopify-app-key';
const APP_SECRET = 'test-shopify-app-secret-0123456789abcdef';
const SCOPES = 'read_products,read_inventory,write_inventory,read_locations';

/** The stand-ins the connect flows talk to: the store host the app dials -> the fake that plays that store. */
const stores = new Map<string, string>();
const resolver = createStubResolver();
const network: ProviderNetwork = {
  resolver: resolver.resolve,
  unsafeTestNetwork: testNetworkFor(),
  sleep: async () => undefined,
  originFor: (target) => {
    const host =
      target.provider === 'shopify'
        ? target.shopDomain
        : new URL(target.storeUrl).hostname;
    return stores.get(host);
  },
};

const problemCore = (b: Record<string, unknown>) => ({
  type: b.type,
  title: b.title,
  status: b.status,
  detail: b.detail,
  code: b.code,
});

describe('Integration connect and OAuth', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let box: SecretBox;
  let config: ApiConfigService;
  let enqueue: jest.SpyInstance;
  const fakes: Array<{ stop(): Promise<void> }> = [];
  const shopIds: string[] = [];

  beforeAll(async () => {
    ctx = await createCatalogApp({
      extraImports: [IntegrationsModule],
      overrides: [{ provide: PROVIDER_NETWORK, useValue: network }],
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    box = ctx.app.get(SecretBox);
    config = ctx.app.get(ApiConfigService);
    enqueue = jest
      .spyOn(ctx.app.get(TaskQueue), 'enqueue')
      .mockResolvedValue('m');
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    enqueue.mockClear();
    resolver.reset();
    stores.clear();
  });

  afterEach(async () => {
    for (const f of fakes.splice(0)) await f.stop();
    if (shopIds.length) {
      const ids = await db.query<{ id: string }>(
        `SELECT "id" FROM "Integration" WHERE "shopId" IN (:shopIds)`,
        { type: QueryTypes.SELECT, replacements: { shopIds } },
      );
      const integrationIds = ids.map((r) => r.id);
      if (integrationIds.length) {
        for (const table of [
          'IntegrationHistory',
          'SyncCursor',
          'ExternalLink',
        ])
          await db.query(
            `DELETE FROM "${table}" WHERE "integrationId" IN (:integrationIds)`,
            {
              replacements: { integrationIds },
            },
          );
        await db.query(
          `DELETE FROM "Outbox" WHERE "aggregateId" IN (:integrationIds)`,
          {
            replacements: { integrationIds: integrationIds },
          },
        );
        await db.query(
          `DELETE FROM "Integration" WHERE "id" IN (:integrationIds)`,
          {
            replacements: { integrationIds },
          },
        );
      }
      await db.query(
        `DELETE FROM "IntegrationInstall" WHERE "shopId" IN (:shopIds)`,
        {
          replacements: { shopIds },
        },
      );
      shopIds.length = 0;
    }
  });

  // ---- helpers ------------------------------------------------------------------------------------------------

  async function newShop() {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    shopIds.push(shop.id);
    return { shop, owner };
  }

  async function member(
    shopId: string,
    role: 'ADMIN' | 'STAFF' | 'VIEWER',
  ): Promise<TestUser> {
    const user = await ctx.newUser();
    await tenancy.addMember(shopId, user.id, role);
    return user;
  }

  async function shopify(
    domain: string,
    options: ConstructorParameters<typeof FakeShopify>[0] = {},
  ) {
    const fake = new FakeShopify({
      shopDomain: domain,
      clientId: APP_KEY,
      clientSecret: APP_SECRET,
      ...options,
    });
    await fake.start();
    fakes.push(fake);
    stores.set(domain, fake.baseUrl);
    return fake;
  }

  async function woo(
    hosts: string[],
    options: ConstructorParameters<typeof FakeWooCommerce>[0] = {},
  ) {
    const fake = new FakeWooCommerce(options);
    await fake.start();
    fakes.push(fake);
    for (const h of hosts) stores.set(h, fake.baseUrl);
    return fake;
  }

  const domainOf = () => `acme-${randomUUID().slice(0, 8)}.myshopify.com`;

  const signCallback = (
    params: Record<string, string>,
    secret = APP_SECRET,
  ) => {
    const message = Object.keys(params)
      .filter((k) => k !== 'hmac')
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    return {
      ...params,
      hmac: createHmac('sha256', secret).update(message).digest('hex'),
    };
  };

  const timestamp = () => String(Math.floor(ctx.clock.now().getTime() / 1000));

  async function install(user: TestUser, shopId: string, shopDomain: string) {
    const res = await ctx
      .as(user)
      .post(`/api/shops/${shopId}/integrations/shopify/install`)
      .send({ shopDomain });
    expect(res.status).toBe(200);
    const parsed = integrationInstallResponseSchema.parse(res.body);
    const state = new URL(parsed.authorizeUrl).searchParams.get('state')!;
    return { state, ...parsed };
  }

  const callback = (params: Record<string, string>) =>
    ctx
      .http()
      .get('/api/integrations/shopify/callback')
      .query(params)
      .redirects(0);

  const goodCallback = (shop: string, state: string, code = 'code-1') =>
    signCallback({ shop, state, code, timestamp: timestamp() });

  const integrationsOf = (shopId: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "Integration" WHERE "shopId" = :shopId`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId },
      },
    );

  const connectedId = (location: string) =>
    new URL(location).searchParams.get('connected');

  const backfillMessages = (integrationId?: string) =>
    enqueue.mock.calls.filter(
      ([queue, body]) =>
        queue === 'integration-backfill' &&
        body.kind === 'backfill' &&
        (integrationId === undefined || body.integrationId === integrationId),
    );

  const outboxRows = (integrationId: string, type: string) =>
    db.query(
      `SELECT * FROM "Outbox" WHERE "aggregateId" = :integrationId AND "type" = :type`,
      { type: QueryTypes.SELECT, replacements: { integrationId, type } },
    );

  /** A complete OAuth round trip; returns the integration id. */
  async function connectShopify(
    user: TestUser,
    shopId: string,
    domain: string,
    code = 'code-1',
  ) {
    const { state } = await install(user, shopId, domain);
    const res = await callback(goodCallback(domain, state, code));
    expect(res.status).toBe(302);
    return connectedId(res.headers.location)!;
  }

  const wooBody = (host: string, extra: Record<string, unknown> = {}) => ({
    provider: 'woocommerce',
    storeUrl: `https://${host}`,
    consumerKey: 'ck_fake',
    consumerSecret: 'cs_fake',
    ...extra,
  });

  // ---- AS-01 / AS-02 install ----------------------------------------------------------------------------------

  it('S08 AS-01: install start returns the authorize URL and stores only a digest of the state', async () => {
    const { shop, owner } = await newShop();
    const res = await ctx
      .as(owner)
      .post(`/api/shops/${shop.id}/integrations/shopify/install`)
      .send({ shopDomain: 'Acme.myshopify.com' });
    expect(res.status).toBe(200);
    const body = integrationInstallResponseSchema.parse(res.body);
    const url = new URL(body.authorizeUrl);
    expect(url.host).toBe('acme.myshopify.com');
    expect(url.pathname).toBe('/admin/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(APP_KEY);
    expect(url.searchParams.get('scope')).toBe(SCOPES);
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${config.get('backend_host').replace(/\/+$/, '')}/api/integrations/shopify/callback`,
    );
    const state = url.searchParams.get('state')!;
    expect(Buffer.from(state, 'base64url').length).toBeGreaterThanOrEqual(16);

    const rows = await db.query<Record<string, any>>(
      `SELECT * FROM "IntegrationInstall" WHERE "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { shopId: shop.id } },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: owner.id,
      shopDomain: 'acme.myshopify.com',
      consumedAt: null,
    });
    expect(JSON.stringify(rows[0])).not.toContain(state);
    expect(rows[0].stateDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      new Date(rows[0].expiresAt).getTime() - ctx.clock.now().getTime(),
    ).toBe(10 * 60_000);
    expect(new Date(body.expiresAt).getTime()).toBe(
      new Date(rows[0].expiresAt).getTime(),
    );
  });

  it.each([
    ['another TLD', { shopDomain: 'acme.com' }],
    ['suffix attack', { shopDomain: 'acme.myshopify.com.evil.io' }],
    ['path trick', { shopDomain: 'evil.com/.myshopify.com' }],
    ['scheme', { shopDomain: 'https://acme.myshopify.com' }],
    ['IP literal', { shopDomain: '10.0.0.1' }],
    ['port', { shopDomain: 'acme.myshopify.com:8443' }],
    ['leading dash', { shopDomain: '-acme.myshopify.com' }],
    ['empty', { shopDomain: '' }],
    ['too long', { shopDomain: `${'a'.repeat(250)}.myshopify.com` }],
    ['extra field', { shopDomain: 'acme.myshopify.com', extra: 1 }],
    ['empty body', {}],
    ['not a string', { shopDomain: 42 }],
  ])(
    'S08 AS-02: install rejects %s with 400 validation_failed and stores nothing',
    async (_name, body) => {
      const { shop, owner } = await newShop();
      const res = await ctx
        .as(owner)
        .post(`/api/shops/${shop.id}/integrations/shopify/install`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.errors.length).toBeGreaterThan(0);
      expect(res.body.errors[0]).toEqual({
        field: expect.any(String),
        code: expect.any(String),
      });
      const rows = await db.query(
        `SELECT 1 FROM "IntegrationInstall" WHERE "shopId" = :shopId`,
        {
          type: QueryTypes.SELECT,
          replacements: { shopId: shop.id },
        },
      );
      expect(rows).toHaveLength(0);
    },
  );

  it('S08 AS-02: staff and viewer get 403, no credentials get 401, nothing persisted', async () => {
    const { shop } = await newShop();
    const staff = await member(shop.id, 'STAFF');
    const viewer = await member(shop.id, 'VIEWER');
    const url = `/api/shops/${shop.id}/integrations/shopify/install`;
    for (const user of [staff, viewer]) {
      const res = await ctx
        .as(user)
        .post(url)
        .send({ shopDomain: 'acme.myshopify.com' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('permission_denied');
    }
    const anonymous = await ctx
      .http()
      .post(url)
      .send({ shopDomain: 'acme.myshopify.com' });
    expect(anonymous.status).toBe(401);
    const rows = await db.query(
      `SELECT 1 FROM "IntegrationInstall" WHERE "shopId" = :shopId`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId: shop.id },
      },
    );
    expect(rows).toHaveLength(0);
  });

  it('S08 AS-02: an admin of the shop may start the install', async () => {
    const { shop } = await newShop();
    const admin = await member(shop.id, 'ADMIN');
    const res = await ctx
      .as(admin)
      .post(`/api/shops/${shop.id}/integrations/shopify/install`)
      .send({ shopDomain: 'acme.myshopify.com' });
    expect(res.status).toBe(200);
  });

  // ---- AS-03 callback success ---------------------------------------------------------------------------------

  it('S08 AS-03: a valid callback connects the store, seals the credentials and registers four webhooks', async () => {
    const { shop, owner } = await newShop();
    const domain = domainOf();
    const fake = await shopify(domain);
    const { state } = await install(owner, shop.id, domain);

    const res = await callback(goodCallback(domain, state));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(`${location.origin}${location.pathname}`).toBe(
      `${config.get('front_host').replace(/\/+$/, '')}/dashboard/integrations`,
    );
    const id = location.searchParams.get('connected')!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    expect(fake.requestsTo('POST', '/admin/oauth/access_token')).toHaveLength(
      1,
    );
    const rows = await integrationsOf(shop.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      provider: 'shopify',
      externalShop: domain,
      status: 'ACTIVE',
      connectedBy: owner.id,
    });
    // sealed: no part of the token, opens only with this integration's context
    expect(rows[0].credentialsSealed).not.toContain(fake.accessToken);
    expect(
      JSON.parse(box.open(rows[0].credentialsSealed, `integration:${id}`)),
    ).toMatchObject({
      provider: 'shopify',
      accessToken: fake.accessToken,
    });
    expect(() =>
      box.open(rows[0].credentialsSealed, `integration:${randomUUID()}`),
    ).toThrow();

    const subscriptions = fake.webhookSubscriptions;
    expect(subscriptions.map((s) => s.topic).sort()).toEqual([
      'app/uninstalled',
      'inventory_levels/update',
      'products/delete',
      'products/update',
    ]);
    const url = `${config.get('backend_host').replace(/\/+$/, '')}/api/integrations/${id}/webhooks`;
    expect(subscriptions.every((s) => s.address === url)).toBe(true);

    const history = await db.query<Record<string, any>>(
      `SELECT * FROM "IntegrationHistory" WHERE "integrationId" = :id`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ toStatus: 'ACTIVE', actorId: owner.id });

    expect(
      await outboxRows(id, 'catalogsync.integration_connected'),
    ).toHaveLength(1);
    expect(backfillMessages(id)).toHaveLength(1);
    expect(backfillMessages(id)[0][1]).toEqual({
      integrationId: id,
      kind: 'backfill',
    });

    const installRows = await db.query<Record<string, any>>(
      `SELECT "consumedAt" FROM "IntegrationInstall" WHERE "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { shopId: shop.id } },
    );
    expect(installRows[0].consumedAt).not.toBeNull();
  });

  // ---- AS-04 / AS-05 callback rejections and races -------------------------------------------------------------

  describe('S08 AS-04: callback rejections', () => {
    const cases: Array<
      [
        string,
        (a: {
          domain: string;
          state: string;
          ctx: CatalogTestApp;
        }) => Promise<Record<string, string>>,
      ]
    > = [
      [
        'wrong hmac',
        async ({ domain, state }) => ({
          ...goodCallback(domain, state),
          hmac: '0'.repeat(64),
        }),
      ],
      [
        'hmac signed with another secret',
        async ({ domain, state }) =>
          signCallback(
            { shop: domain, state, code: 'c', timestamp: timestamp() },
            'other-secret',
          ),
      ],
      [
        'altered parameter',
        async ({ domain, state }) => ({
          ...goodCallback(domain, state),
          code: 'altered',
        }),
      ],
      [
        'old timestamp',
        async ({ domain, state }) =>
          signCallback({
            shop: domain,
            state,
            code: 'c',
            timestamp: String(
              Math.floor(ctx.clock.now().getTime() / 1000) - 301,
            ),
          }),
      ],
      [
        'unknown state',
        async ({ domain }) => goodCallback(domain, 'a-state-nobody-issued'),
      ],
      [
        'shop differs from the install',
        async ({ state }) =>
          goodCallback(
            `other-${randomUUID().slice(0, 8)}.myshopify.com`,
            state,
          ),
      ],
      [
        'missing code',
        async ({ domain, state }) =>
          signCallback({ shop: domain, state, timestamp: timestamp() }),
      ],
      [
        'expired state',
        async ({ domain, state }) => {
          ctx.clock.advance(10 * 60_000 + 1000);
          return goodCallback(domain, state);
        },
      ],
    ];

    it.each(cases)(
      '%s answers the same 400 invalid_oauth_callback, no exchange, nothing stored',
      async (_n, make) => {
        const { shop, owner } = await newShop();
        const domain = domainOf();
        const fake = await shopify(domain);
        const { state } = await install(owner, shop.id, domain);

        const reference = await callback({
          shop: domain,
          state: 'nope',
          code: 'x',
          hmac: 'y',
          timestamp: '1',
        });
        const res = await callback(await make({ domain, state, ctx }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid_oauth_callback');
        expect(problemCore(res.body)).toEqual(problemCore(reference.body));
        expect(
          fake.requestsTo('POST', '/admin/oauth/access_token'),
        ).toHaveLength(0);
        expect(await integrationsOf(shop.id)).toHaveLength(0);
        expect(backfillMessages()).toHaveLength(0);
      },
    );

    it('a used state answers the same 400', async () => {
      const { shop, owner } = await newShop();
      const domain = domainOf();
      await shopify(domain);
      const { state } = await install(owner, shop.id, domain);
      expect((await callback(goodCallback(domain, state))).status).toBe(302);
      const again = await callback(goodCallback(domain, state));
      expect(again.status).toBe(400);
      expect(again.body.code).toBe('invalid_oauth_callback');
      expect(await integrationsOf(shop.id)).toHaveLength(1);
    });

    it('a refused code exchange redirects with ?error=oauth_exchange_failed and stores nothing', async () => {
      const { shop, owner } = await newShop();
      const domain = domainOf();
      const fake = await shopify(domain);
      fake.validCodes = new Set(['the-only-good-code']);
      const { state } = await install(owner, shop.id, domain);
      const res = await callback(goodCallback(domain, state, 'bad-code'));
      expect(res.status).toBe(302);
      expect(new URL(res.headers.location).searchParams.get('error')).toBe(
        'oauth_exchange_failed',
      );
      expect(fake.requestsTo('POST', '/admin/oauth/access_token')).toHaveLength(
        1,
      );
      expect(await integrationsOf(shop.id)).toHaveLength(0);
      expect(fake.webhookSubscriptions).toHaveLength(0);
      expect(backfillMessages()).toHaveLength(0);
    });
  });

  it('S08 AS-05: two simultaneous valid callbacks and a later one yield one 302, one integration, one event, one message', async () => {
    const { shop, owner } = await newShop();
    const domain = domainOf();
    await shopify(domain);
    const { state } = await install(owner, shop.id, domain);
    const query = goodCallback(domain, state);
    const [a, b] = await Promise.all([callback(query), callback(query)]);
    const later = await callback(query);

    const statuses = [a.status, b.status, later.status].sort();
    expect(statuses).toEqual([302, 400, 400]);
    for (const r of [a, b, later].filter((r) => r.status === 400))
      expect(r.body.code).toBe('invalid_oauth_callback');
    const rows = await integrationsOf(shop.id);
    expect(rows).toHaveLength(1);
    expect(
      await outboxRows(rows[0].id, 'catalogsync.integration_connected'),
    ).toHaveLength(1);
    expect(backfillMessages(rows[0].id)).toHaveLength(1);
  });

  // ---- AS-06 WooCommerce connect --------------------------------------------------------------------------------

  describe('S08 AS-06: WooCommerce connect', () => {
    it('verifies the keys, registers webhooks with a generated secret and answers 201 without secrets', async () => {
      const { shop, owner } = await newShop();
      const host = `shop-${randomUUID().slice(0, 8)}.example.com`;
      const fake = await woo([host]);
      const res = await ctx
        .as(owner)
        .post(`/api/shops/${shop.id}/integrations`)
        .send(wooBody(host));
      expect(res.status).toBe(201);
      const body = integrationSchema.parse(res.body);
      expect(body).toMatchObject({
        provider: 'woocommerce',
        externalShop: `https://${host}`,
        status: 'ACTIVE',
        credentialsSet: true,
      });
      expect(JSON.stringify(res.body)).not.toMatch(/ck_fake|cs_fake/);
      expect(fake.requests.length).toBeGreaterThan(0);
      expect(
        fake.requests.every((r) =>
          r.headers.authorization?.startsWith('Basic '),
        ),
      ).toBe(true);

      const rows = await integrationsOf(shop.id);
      expect(rows).toHaveLength(1);
      const credentials = JSON.parse(
        box.open(rows[0].credentialsSealed, `integration:${body.id}`),
      );
      expect(credentials).toMatchObject({
        provider: 'woocommerce',
        consumerKey: 'ck_fake',
        consumerSecret: 'cs_fake',
      });
      expect(credentials.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(fake.webhooks.length).toBeGreaterThan(0);
      expect(
        fake.webhooks.every((h) => h.secret === credentials.webhookSecret),
      ).toBe(true);
      expect(
        fake.webhooks.every((h) =>
          h.delivery_url.endsWith(`/api/integrations/${body.id}/webhooks`),
        ),
      ).toBe(true);
      expect(backfillMessages(body.id)).toHaveLength(1);
      expect(
        await outboxRows(body.id, 'catalogsync.integration_connected'),
      ).toHaveLength(1);
    });

    it('repeats of the same store answer 200 with the same integration and replaced credentials', async () => {
      const { shop, owner } = await newShop();
      const host = `shop-${randomUUID().slice(0, 8)}.example.com`;
      await woo([host]);
      const first = await ctx
        .as(owner)
        .post(`/api/shops/${shop.id}/integrations`)
        .send(wooBody(host));
      const sealedBefore = (await integrationsOf(shop.id))[0].credentialsSealed;
      const second = await ctx
        .as(owner)
        .post(`/api/shops/${shop.id}/integrations`)
        .send(wooBody(host));
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(second.body.status).toBe('ACTIVE');
      const rows = await integrationsOf(shop.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].credentialsSealed).not.toBe(sealedBefore);
      expect(backfillMessages(first.body.id)).toHaveLength(1);
    });

    it('rejected keys answer 422 provider_credentials_rejected and store nothing', async () => {
      const { shop, owner } = await newShop();
      const host = `shop-${randomUUID().slice(0, 8)}.example.com`;
      const fake = await woo([host]);
      const res = await ctx
        .as(owner)
        .post(`/api/shops/${shop.id}/integrations`)
        .send(wooBody(host, { consumerKey: 'ck_wrong' }));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('provider_credentials_rejected');
      expect(await integrationsOf(shop.id)).toHaveLength(0);
      expect(fake.webhooks).toHaveLength(0);
      expect(backfillMessages()).toHaveLength(0);
    });

    it.each([
      ['a 503 answer', { kind: 'status', status: 503 }],
      ['a dropped connection', { kind: 'drop' }],
    ] as const)(
      '%s answers 503 provider_unavailable with a generic detail and stores nothing',
      async (_n, fault) => {
        const { shop, owner } = await newShop();
        const host = `shop-${randomUUID().slice(0, 8)}.example.com`;
        const fake = await woo([host]);
        fake.inject({ fault });
        const res = await ctx
          .as(owner)
          .post(`/api/shops/${shop.id}/integrations`)
          .send(wooBody(host));
        expect(res.status).toBe(503);
        expect(res.body.code).toBe('provider_unavailable');
        expect(JSON.stringify(res.body)).not.toContain(host);
        expect(await integrationsOf(shop.id)).toHaveLength(0);
        expect(backfillMessages()).toHaveLength(0);
      },
    );

    it.each([
      ['provider fake', { provider: 'fake' }],
      ['legacy credentials field', { credentials: 'x' }],
      ['unknown field', { surprise: true }],
      ['missing secret', { consumerSecret: undefined }],
    ])('%s is a 400 validation_failed', async (_n, extra) => {
      const { shop, owner } = await newShop();
      const res = await ctx
        .as(owner)
        .post(`/api/shops/${shop.id}/integrations`)
        .send(wooBody('shop.example.com', extra));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_failed');
    });
  });

  // ---- AS-07 store address guard --------------------------------------------------------------------------------

  describe('S08 AS-07: store URL guard', () => {
    const syntactic: Array<[string, string]> = [
      ['http scheme', 'http://shop.example.com'],
      ['user-info', 'https://user:pw@shop.example.com'],
      ['port 8443', 'https://shop.example.com:8443'],
      ['IPv4 literal', 'https://93.184.216.34'],
      ['IPv6 literal', 'https://[2606:2800:220:1:248:1893:25c8:1946]'],
      ['loopback literal', 'https://127.0.0.1'],
      ['localhost', 'https://localhost'],
    ];
    it.each(syntactic)(
      '%s is refused 422 invalid_store_url with no outbound call',
      async (_n, storeUrl) => {
        const { shop, owner } = await newShop();
        const fake = await woo([
          'shop.example.com',
          'localhost',
          '127.0.0.1',
          '93.184.216.34',
        ]);
        const res = await ctx
          .as(owner)
          .post(`/api/shops/${shop.id}/integrations`)
          .send({ ...wooBody('x'), storeUrl });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('invalid_store_url');
        expect(fake.requests).toHaveLength(0);
        expect(await integrationsOf(shop.id)).toHaveLength(0);
      },
    );

    const resolving: Array<[string, string]> = [
      ['loopback', PRIVATE_ADDRESSES.loopback],
      ['IPv6 loopback', PRIVATE_ADDRESSES.loopbackV6],
      ['10/8', PRIVATE_ADDRESSES.private10],
      ['172.16/12', PRIVATE_ADDRESSES.private172],
      ['192.168/16', PRIVATE_ADDRESSES.private192],
      ['cloud metadata', PRIVATE_ADDRESSES.linkLocalMetadata],
      ['unique-local IPv6', PRIVATE_ADDRESSES.uniqueLocalV6],
      ['multicast', '224.0.0.1'],
    ];
    it.each(resolving)(
      'a name resolving to %s is refused 422 invalid_store_url with no outbound call',
      async (_n, address) => {
        const { shop, owner } = await newShop();
        const host = `hostile-${randomUUID().slice(0, 8)}.example.com`;
        const fake = await woo([host]);
        resolver.set(host, address);
        const res = await ctx
          .as(owner)
          .post(`/api/shops/${shop.id}/integrations`)
          .send(wooBody(host));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('invalid_store_url');
        expect(fake.requests).toHaveLength(0);
        expect(await integrationsOf(shop.id)).toHaveLength(0);
      },
    );

    it('DNS rebinding (public at validation, private at call time) is refused at call time', async () => {
      const { shop, owner } = await newShop();
      const host = `rebind-${randomUUID().slice(0, 8)}.example.com`;
      // no stand-in for this store: the call dials the real name, which now resolves to a private address
      resolver.rebind(host, PUBLIC_ADDRESS, PRIVATE_ADDRESSES.private10);
      const res = await ctx
        .as(owner)
        .post(`/api/shops/${shop.id}/integrations`)
        .send(wooBody(host));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('invalid_store_url');
      expect(
        resolver.calls.filter((h) => h === host).length,
      ).toBeGreaterThanOrEqual(2);
      expect(await integrationsOf(shop.id)).toHaveLength(0);
    });

    it('a redirect answer is refused, never followed', async () => {
      const { shop, owner } = await newShop();
      const host = `redir-${randomUUID().slice(0, 8)}.example.com`;
      const fake = await woo([host]);
      fake.inject({
        fault: {
          kind: 'status',
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        },
      });
      const res = await ctx
        .as(owner)
        .post(`/api/shops/${shop.id}/integrations`)
        .send(wooBody(host));
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('invalid_store_url');
      expect(fake.requests.every((r) => r.path.startsWith('/wp-json/'))).toBe(
        true,
      );
      expect(await integrationsOf(shop.id)).toHaveLength(0);
    });
  });

  // ---- AS-08 currency -------------------------------------------------------------------------------------------

  it('S08 AS-08: a Woo store in another currency is 422 currency_mismatch and nothing is created', async () => {
    const { shop, owner } = await newShop();
    const host = `shop-${randomUUID().slice(0, 8)}.example.com`;
    const fake = await woo([host], { currency: 'EUR' });
    const res = await ctx
      .as(owner)
      .post(`/api/shops/${shop.id}/integrations`)
      .send(wooBody(host));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('currency_mismatch');
    expect(await integrationsOf(shop.id)).toHaveLength(0);
    expect(fake.webhooks).toHaveLength(0);
    expect(backfillMessages()).toHaveLength(0);
  });

  it('S08 AS-08: a Shopify store in another currency redirects ?error=currency_mismatch and registers nothing', async () => {
    const { shop, owner } = await newShop();
    const domain = domainOf();
    const fake = await shopify(domain, { currency: 'EUR' });
    const { state } = await install(owner, shop.id, domain);
    const res = await callback(goodCallback(domain, state));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.location).searchParams.get('error')).toBe(
      'currency_mismatch',
    );
    expect(await integrationsOf(shop.id)).toHaveLength(0);
    expect(fake.webhookSubscriptions).toHaveLength(0);
    expect(backfillMessages()).toHaveLength(0);
  });

  // ---- AS-09 reconnect ------------------------------------------------------------------------------------------

  it.each(['NEEDS_REAUTH', 'DISCONNECTED'])(
    'S08 AS-09: reconnecting a %s integration reuses the id, replaces credentials, resets the cursor and keeps links',
    async (status) => {
      const { shop, owner } = await newShop();
      const domain = domainOf();
      await shopify(domain);
      const id = await connectShopify(owner, shop.id, domain);
      const productId = randomUUID();
      await db.query(
        `INSERT INTO "ExternalLink" ("integrationId", "entity", "externalId", "localId", "shopId", "state", "contentDigest",
                                     "syncedStock", "lastLocalVersion", "raw", "updatedAt")
         VALUES (:id, 'product', '1:2', :productId, :shopId, 'ACTIVE', 'digest', 0, 1, '{}'::jsonb, now())`,
        { replacements: { id, productId, shopId: shop.id } },
      );
      await db.query(
        `INSERT INTO "SyncCursor" ("integrationId", "entity", "watermark") VALUES (:id, 'product', now())
         ON CONFLICT ("integrationId", "entity") DO UPDATE SET "watermark" = now()`,
        { replacements: { id } },
      );
      await db.query(
        `UPDATE "Integration" SET "status" = :status, "credentialsSealed" = CASE WHEN :status = 'DISCONNECTED' THEN NULL ELSE "credentialsSealed" END WHERE "id" = :id`,
        { replacements: { id, status } },
      );
      enqueue.mockClear();

      // the store now hands out another token
      await fakes.pop()!.stop();
      const fake = await shopify(domain, { accessToken: 'shpat_rotated' });
      const again = await connectShopify(owner, shop.id, domain, 'code-2');
      expect(again).toBe(id);

      const rows = await integrationsOf(shop.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('ACTIVE');
      expect(
        JSON.parse(box.open(rows[0].credentialsSealed, `integration:${id}`))
          .accessToken,
      ).toBe('shpat_rotated');
      const history = await db.query<Record<string, any>>(
        `SELECT "fromStatus", "toStatus" FROM "IntegrationHistory" WHERE "integrationId" = :id ORDER BY "at", "id"`,
        { type: QueryTypes.SELECT, replacements: { id } },
      );
      expect(history[history.length - 1]).toMatchObject({
        fromStatus: status,
        toStatus: 'ACTIVE',
      });
      const cursors = await db.query<Record<string, any>>(
        `SELECT "watermark" FROM "SyncCursor" WHERE "integrationId" = :id`,
        { type: QueryTypes.SELECT, replacements: { id } },
      );
      expect(cursors.filter((c) => c.watermark !== null)).toEqual([]);
      const links = await db.query<Record<string, any>>(
        `SELECT "localId" FROM "ExternalLink" WHERE "integrationId" = :id`,
        { type: QueryTypes.SELECT, replacements: { id } },
      );
      expect(links).toEqual([{ localId: productId }]);
      expect(backfillMessages(id)).toHaveLength(1);
      expect(fake.webhookSubscriptions).toHaveLength(4);
    },
  );

  // ---- AS-10 one connection per store ---------------------------------------------------------------------------

  it('S08 AS-10: a store held by another shop is refused with ?error=store_already_connected', async () => {
    const a = await newShop();
    const b = await newShop();
    const domain = domainOf();
    await shopify(domain);
    await connectShopify(a.owner, a.shop.id, domain);
    enqueue.mockClear();

    const { state } = await install(b.owner, b.shop.id, domain);
    const res = await callback(goodCallback(domain, state));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.location).searchParams.get('error')).toBe(
      'store_already_connected',
    );
    expect(await integrationsOf(b.shop.id)).toHaveLength(0);
    expect(backfillMessages()).toHaveLength(0);
  });

  it('S08 AS-10: two shops completing a free store at the same moment yield exactly one integration', async () => {
    const a = await newShop();
    const b = await newShop();
    const domain = domainOf();
    await shopify(domain);
    const [ia, ib] = await Promise.all([
      install(a.owner, a.shop.id, domain),
      install(b.owner, b.shop.id, domain),
    ]);
    const [ra, rb] = await Promise.all([
      callback(goodCallback(domain, ia.state)),
      callback(goodCallback(domain, ib.state)),
    ]);
    const results = [ra, rb].map(
      (r) => new URL(r.headers.location).searchParams,
    );
    expect(results.filter((p) => p.get('connected')).length).toBe(1);
    expect(
      results.filter((p) => p.get('error') === 'store_already_connected')
        .length,
    ).toBe(1);
    const all = [
      ...(await integrationsOf(a.shop.id)),
      ...(await integrationsOf(b.shop.id)),
    ];
    expect(all.filter((r) => r.status !== 'DISCONNECTED')).toHaveLength(1);
  });

  // ---- AS-11 integration limit ----------------------------------------------------------------------------------

  it('S08 AS-11: a sixth integration is refused 409 integration_limit_reached', async () => {
    const { shop, owner } = await newShop();
    const hosts = Array.from(
      { length: 6 },
      (_, i) => `s${i}-${randomUUID().slice(0, 6)}.example.com`,
    );
    await woo(hosts);
    for (const h of hosts.slice(0, 5)) {
      const ok = await ctx
        .as(owner)
        .post(`/api/shops/${shop.id}/integrations`)
        .send(wooBody(h));
      expect(ok.status).toBe(201);
    }
    enqueue.mockClear();
    const sixth = await ctx
      .as(owner)
      .post(`/api/shops/${shop.id}/integrations`)
      .send(wooBody(hosts[5]));
    expect(sixth.status).toBe(409);
    expect(sixth.body.code).toBe('integration_limit_reached');
    expect(await integrationsOf(shop.id)).toHaveLength(5);
    expect(backfillMessages()).toHaveLength(0);
  });

  it('S08 AS-11: a Shopify callback at the limit redirects ?error=integration_limit_reached', async () => {
    const { shop, owner } = await newShop();
    const hosts = Array.from(
      { length: 5 },
      (_, i) => `s${i}-${randomUUID().slice(0, 6)}.example.com`,
    );
    await woo(hosts);
    for (const h of hosts)
      expect(
        (
          await ctx
            .as(owner)
            .post(`/api/shops/${shop.id}/integrations`)
            .send(wooBody(h))
        ).status,
      ).toBe(201);
    const domain = domainOf();
    await shopify(domain);
    const { state } = await install(owner, shop.id, domain);
    const res = await callback(goodCallback(domain, state));
    expect(new URL(res.headers.location).searchParams.get('error')).toBe(
      'integration_limit_reached',
    );
    expect(await integrationsOf(shop.id)).toHaveLength(5);
  });

  it('S08 AS-11: two different stores connected at the same moment at 4 integrations never exceed 5', async () => {
    const { shop, owner } = await newShop();
    const hosts = Array.from(
      { length: 6 },
      (_, i) => `s${i}-${randomUUID().slice(0, 6)}.example.com`,
    );
    await woo(hosts);
    for (const h of hosts.slice(0, 4))
      expect(
        (
          await ctx
            .as(owner)
            .post(`/api/shops/${shop.id}/integrations`)
            .send(wooBody(h))
        ).status,
      ).toBe(201);
    const [x, y] = await Promise.all([
      ctx
        .as(owner)
        .post(`/api/shops/${shop.id}/integrations`)
        .send(wooBody(hosts[4])),
      ctx
        .as(owner)
        .post(`/api/shops/${shop.id}/integrations`)
        .send(wooBody(hosts[5])),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect([x, y].find((r) => r.status === 409)!.body.code).toBe(
      'integration_limit_reached',
    );
    expect(
      (await integrationsOf(shop.id)).filter(
        (r) => r.status !== 'DISCONNECTED',
      ),
    ).toHaveLength(5);
  });
});
