import { randomUUID } from 'node:crypto';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import {
  integrationPageSchema,
  integrationSchema,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  createCatalogApp,
  type CatalogTestApp,
} from '@app/test/utils/catalog-app';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  IntegrationsModule,
  IntegrationsWorkerModule,
} from './integrations.module';
import { SyncEngineService } from './application/sync-engine.service';
import { serialiseCredentials } from './domain/credentials';
import type { IntegrationStatus } from './domain/integration-status';
import {
  CREDENTIAL_VAULT,
  CURSOR_REPOSITORY,
  INTEGRATION_BACKFILL_QUEUE,
  INTEGRATION_REPOSITORY,
  INTEGRATION_SYNC_QUEUE,
  type CredentialVault,
  type CursorRepository,
  type IntegrationRepository,
  type SyncMessage,
} from './domain/ports';
import {
  PROVIDER_NETWORK,
  type ProviderNetwork,
} from './infra/provider-network';
import { FakeShopify } from './test/fakes/fake-shopify';
import { testNetworkFor } from './test/fakes/provider-harness';
import { createStubResolver } from './test/fakes/stub-resolver';
import {
  TenancyFixture,
  type FixtureRole,
} from '@app/test/utils/s08-tenancy-fixture';

const MIN = 60_000;
const SCOPES = 'read_products,read_inventory,write_inventory,read_locations';
const SECRET_FRAGMENTS = [
  'credentialsSealed',
  'consumerSecret',
  'webhookSecret',
  'accessToken',
  'shpat_',
];

const stores = new Map<string, string>();
const resolver = createStubResolver();
const network: ProviderNetwork = {
  resolver: resolver.resolve,
  unsafeTestNetwork: testNetworkFor(),
  sleep: async () => undefined,
  originFor: (target) =>
    target.provider === 'shopify' ? stores.get(target.shopDomain) : undefined,
};

describe('Integration management API', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let config: ApiConfigService;
  let engine: SyncEngineService;
  let integrations: IntegrationRepository;
  let cursors: CursorRepository;
  let vault: CredentialVault;
  let enqueue: jest.SpyInstance;
  const fakes: FakeShopify[] = [];
  const integrationIds: string[] = [];

  beforeAll(async () => {
    ctx = await createCatalogApp({
      extraImports: [IntegrationsModule, IntegrationsWorkerModule],
      overrides: [{ provide: PROVIDER_NETWORK, useValue: network }],
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    config = ctx.app.get(ApiConfigService);
    const worker = ctx.app.select(IntegrationsWorkerModule);
    engine = worker.get(SyncEngineService);
    integrations = worker.get(INTEGRATION_REPOSITORY);
    cursors = worker.get(CURSOR_REPOSITORY);
    vault = worker.get(CREDENTIAL_VAULT);
    enqueue = jest
      .spyOn(ctx.app.get(TaskQueue), 'enqueue')
      .mockResolvedValue('m');
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    resolver.reset();
    stores.clear();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    enqueue = jest
      .spyOn(ctx.app.get(TaskQueue), 'enqueue')
      .mockResolvedValue('m');
    for (const f of fakes.splice(0)) await f.stop();
    if (integrationIds.length) {
      const replacements = { ids: integrationIds };
      for (const table of [
        'SyncRun',
        'SyncCursor',
        'ExternalLink',
        'SyncQuarantine',
        'StockConflict',
        'CatalogReconciliationRun',
        'IntegrationHistory',
      ])
        await db.query(
          `DELETE FROM "${table}" WHERE "integrationId" IN (:ids)`,
          { replacements },
        );
      await db.query(`DELETE FROM "Outbox" WHERE "aggregateId" IN (:ids)`, {
        replacements,
      });
      await db.query(`DELETE FROM "Integration" WHERE "id" IN (:ids)`, {
        replacements,
      });
      integrationIds.length = 0;
    }
  });

  // ---- helpers ------------------------------------------------------------------------------------------------

  interface Seller {
    shopId: string;
    owner: TestUser;
  }

  async function seller(): Promise<Seller> {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    return { shopId: shop.id, owner };
  }

  /** An integration of `shopId` in `status`, against its own fake store. */
  async function integrationIn(
    s: Seller,
    status: IntegrationStatus = 'ACTIVE',
    options: { createdAt?: Date; pageSize?: number } = {},
  ) {
    const domain = `manage-${randomUUID().slice(0, 8)}.myshopify.com`;
    const fake = new FakeShopify({
      shopDomain: domain,
      pageSize: options.pageSize ?? 50,
    });
    fake.now = () => ctx.clock.now();
    await fake.start();
    fakes.push(fake);
    stores.set(domain, fake.baseUrl);
    const id = randomUUID();
    const inserted = await integrations.insertConnected({
      id,
      shopId: s.shopId,
      provider: 'shopify',
      externalShop: domain,
      credentialsSealed: vault.seal(
        id,
        serialiseCredentials({
          provider: 'shopify',
          accessToken: fake.accessToken,
          scope: SCOPES,
        }),
      ),
      locationId: String(fake.locationId),
      connectedBy: s.owner.id,
      now: options.createdAt ?? ctx.clock.now(),
      maxPerShop: 20,
    });
    expect(inserted.kind).toBe('inserted');
    integrationIds.push(id);
    const to: Record<IntegrationStatus, () => Promise<unknown>> = {
      ACTIVE: async () => undefined,
      PAUSED: () =>
        integrations.transition(id, 'ACTIVE', 'PAUSED', {
          reason: 'seller',
          actorId: null,
          now: ctx.clock.now(),
          pausedReason: 'seller',
        }),
      NEEDS_REAUTH: () =>
        integrations.transition(id, 'ACTIVE', 'NEEDS_REAUTH', {
          reason: 'auth_failed',
          actorId: null,
          now: ctx.clock.now(),
        }),
      DISCONNECTED: () =>
        integrations.transition(id, 'ACTIVE', 'DISCONNECTED', {
          reason: 'disconnected',
          actorId: null,
          now: ctx.clock.now(),
          eraseCredentials: true,
        }),
    };
    await to[status]();
    return {
      ...s,
      id,
      fake,
      domain,
      path: `/api/shops/${s.shopId}/integrations/${id}`,
    };
  }

  const rowOf = async (id: string) =>
    (
      await db.query<Record<string, any>>(
        `SELECT * FROM "Integration" WHERE "id" = :id`,
        { type: QueryTypes.SELECT, replacements: { id } },
      )
    )[0];

  /** The history rows written by the management routes (the rows of the fixture's own set-up are left out). */
  const historyOf = (id: string) =>
    db.query<Record<string, any>>(
      `SELECT * FROM "IntegrationHistory" WHERE "integrationId" = :id AND "reason" IN ('pause', 'resume', 'disconnect')
        ORDER BY "at", "id"`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );

  /** Status events written by the management routes (the fixture writes none). */
  const eventsOf = async (
    id: string,
    type = 'catalogsync.integration_status_changed',
  ) =>
    (
      await db.query<{ body: Record<string, any> }>(
        `SELECT payload->'payload' AS body FROM "Outbox" WHERE "aggregateId" = :id AND "type" = :type ORDER BY "createdAt", "id"`,
        { type: QueryTypes.SELECT, replacements: { id, type } },
      )
    ).map((r) => r.body);

  const sent = (queue: string) =>
    enqueue.mock.calls
      .filter((c) => c[0] === queue)
      .map((c) => c[1] as SyncMessage);

  const problemShape = (b: any) => ({
    code: b.code,
    title: b.title,
    status: b.status,
    detail: b.detail,
  });

  const backfillMsg = (integrationId: string): SyncMessage => ({
    integrationId,
    kind: 'backfill',
  });

  // ---- AS-67 ---------------------------------------------------------------------------------------------------

  describe('list and detail', () => {
    it('S08 AS-67: seven integrations page three at a time newest first with an opaque cursor; bad limits and a tampered cursor are 400; the bodies parse and carry no secret', async () => {
      const s = await seller();
      const made = await Promise.all(
        Array.from({ length: 7 }, (_, i) =>
          integrationIn(s, i === 3 ? 'DISCONNECTED' : 'ACTIVE', {
            createdAt: new Date(ctx.clock.now().getTime() + i * 1000),
          }),
        ),
      );
      const expected = made.map((m) => m.id).reverse();

      const seen: string[] = [];
      let cursor: string | null = null;
      const sizes: number[] = [];
      const bodies: string[] = [];
      for (let guard = 0; guard < 5; guard++) {
        const res = await ctx
          .as(s.owner)
          .get(
            `/api/shops/${s.shopId}/integrations?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          );
        expect(res.status).toBe(200);
        bodies.push(JSON.stringify(res.body));
        const page = integrationPageSchema.parse(res.body);
        sizes.push(page.items.length);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(sizes).toEqual([3, 3, 1]);
      expect(seen).toEqual(expected);

      // Stable under inserts: a newer integration does not shift the second page.
      const first = await ctx
        .as(s.owner)
        .get(`/api/shops/${s.shopId}/integrations?limit=3`);
      const firstPage = integrationPageSchema.parse(first.body);
      await integrationIn(s, 'ACTIVE', {
        createdAt: new Date(ctx.clock.now().getTime() + 60_000),
      });
      const next = await ctx
        .as(s.owner)
        .get(
          `/api/shops/${s.shopId}/integrations?limit=3&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
        );
      expect(
        integrationPageSchema.parse(next.body).items.map((i) => i.id),
      ).toEqual(expected.slice(3, 6));

      const defaults = await ctx
        .as(s.owner)
        .get(`/api/shops/${s.shopId}/integrations`);
      expect(integrationPageSchema.parse(defaults.body).items).toHaveLength(8);

      for (const bad of [
        'limit=0',
        'limit=101',
        'limit=abc',
        'limit=-1',
        'limit=1.5',
      ]) {
        const res = await ctx
          .as(s.owner)
          .get(`/api/shops/${s.shopId}/integrations?${bad}`);
        expect([bad, res.status]).toEqual([bad, 400]);
        expect(res.body.code).toBe('validation_failed');
      }
      const tampered = `${firstPage.nextCursor!.slice(0, -2)}xx`;
      const forged = await ctx
        .as(s.owner)
        .get(
          `/api/shops/${s.shopId}/integrations?cursor=${encodeURIComponent(tampered)}`,
        );
      expect(forged.status).toBe(400);
      expect(forged.body.code).toBe('invalid_cursor');
      const garbage = await ctx
        .as(s.owner)
        .get(`/api/shops/${s.shopId}/integrations?cursor=not-a-cursor`);
      expect(garbage.status).toBe(400);

      // The disconnected one shows no credentials; the others do.
      const items = integrationPageSchema.parse(defaults.body).items;
      expect(items.find((i) => i.id === made[3].id)).toMatchObject({
        status: 'DISCONNECTED',
        credentialsSet: false,
      });
      expect(items.find((i) => i.id === made[0].id)).toMatchObject({
        credentialsSet: true,
      });

      for (const body of [...bodies, JSON.stringify(defaults.body)])
        for (const fragment of SECRET_FRAGMENTS)
          expect(body).not.toContain(fragment);
      const sealed = (await rowOf(made[0].id)).credentialsSealed as string;
      expect(JSON.stringify(defaults.body)).not.toContain(sealed);
      expect(JSON.stringify(defaults.body)).not.toContain(
        made[0].fake.accessToken,
      );
    });

    it('S08 AS-67: the detail has every field of integrationSchema with the counts and the lag, and never a credential', async () => {
      const s = await seller();
      const t = await integrationIn(s);
      t.fake.addProduct({
        title: 'A',
        stock: 1,
        updatedAt: new Date(ctx.clock.now().getTime() - 10 * MIN),
      });
      t.fake.addProduct({
        title: 'B',
        stock: 1,
        updatedAt: new Date(ctx.clock.now().getTime() - 20 * MIN),
      });
      t.fake.addProduct({
        title: 'Bad',
        price: 'free',
        stock: 1,
        updatedAt: new Date(ctx.clock.now().getTime() - 30 * MIN),
      });
      await engine.handle(backfillMsg(t.id));

      const res = await ctx.as(s.owner).get(t.path);
      expect(res.status).toBe(200);
      const parsed = integrationSchema.parse(res.body);
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'id',
          'provider',
          'externalShop',
          'status',
          'pausedReason',
          'lastError',
          'lastSyncAt',
          'watermark',
          'lagSeconds',
          'linkedProducts',
          'openQuarantine',
          'openConflicts',
          'breakerOpenUntil',
          'credentialsSet',
          'createdAt',
        ].sort(),
      );
      expect(parsed).toMatchObject({
        id: t.id,
        provider: 'shopify',
        externalShop: t.domain,
        status: 'ACTIVE',
        pausedReason: null,
        linkedProducts: 2,
        openQuarantine: 1,
        openConflicts: 0,
        credentialsSet: true,
        breakerOpenUntil: null,
      });
      expect(parsed.lagSeconds).toBe(10 * 60);
      expect(new Date(parsed.watermark!).getTime()).toBe(
        ctx.clock.now().getTime() - 10 * MIN,
      );
      const text = JSON.stringify(res.body);
      for (const fragment of SECRET_FRAGMENTS)
        expect(text).not.toContain(fragment);
      expect(text).not.toContain(t.fake.accessToken);
      expect(
        (await ctx.as(s.owner).get(`${t.path.replace(t.id, randomUUID())}`))
          .status,
      ).toBe(404);
    });
  });

  // ---- AS-68 ---------------------------------------------------------------------------------------------------

  describe('pause and resume', () => {
    it('S08 AS-68: pause and resume per state; illegal moves are 409 invalid_integration_transition with no event and no history row; resume queues an incremental pull and a reconcile', async () => {
      const s = await seller();
      const active = await integrationIn(s, 'ACTIVE');
      const paused = await integrationIn(s, 'PAUSED');
      const reauth = await integrationIn(s, 'NEEDS_REAUTH');
      const gone = await integrationIn(s, 'DISCONNECTED');
      const as = ctx.as(s.owner);

      // Refusals first: nothing changes anywhere.
      const snapshot = async (id: string) => ({
        row: (({ updatedAt, ...r }) => r)(await rowOf(id)),
        history: (await historyOf(id)).length,
        events: (await eventsOf(id)).length,
      });
      const before = {
        active: await snapshot(active.id),
        paused: await snapshot(paused.id),
        reauth: await snapshot(reauth.id),
        gone: await snapshot(gone.id),
      };
      enqueue.mockClear();
      const refusals: Array<
        [string, { path: string; id: string }, 'pause' | 'resume']
      > = [
        ['active', active, 'resume'],
        ['paused', paused, 'pause'],
        ['reauth', reauth, 'pause'],
        ['reauth', reauth, 'resume'],
        ['gone', gone, 'pause'],
        ['gone', gone, 'resume'],
      ];
      for (const [label, target, action] of refusals) {
        const res = await as.post(`${target.path}/${action}`);
        expect([label, action, res.status]).toEqual([label, action, 409]);
        expect(res.body.code).toBe('invalid_integration_transition');
      }
      expect({
        active: await snapshot(active.id),
        paused: await snapshot(paused.id),
        reauth: await snapshot(reauth.id),
        gone: await snapshot(gone.id),
      }).toEqual(before);
      expect(enqueue).not.toHaveBeenCalled();

      // ACTIVE -> pause.
      const events = (await eventsOf(active.id)).length;
      const pausedRes = await as.post(`${active.path}/pause`);
      expect(pausedRes.status).toBe(200);
      expect(integrationSchema.parse(pausedRes.body)).toMatchObject({
        status: 'PAUSED',
        pausedReason: 'seller',
      });
      expect(await historyOf(active.id)).toEqual([
        expect.objectContaining({
          fromStatus: 'ACTIVE',
          toStatus: 'PAUSED',
          actorId: s.owner.id,
        }),
      ]);
      const changed = await eventsOf(active.id);
      expect(changed).toHaveLength(events + 1);
      expect(changed.at(-1)).toMatchObject({
        from: 'ACTIVE',
        to: 'PAUSED',
        reason: 'seller',
        shopId: s.shopId,
      });
      expect(enqueue).not.toHaveBeenCalled();

      // PAUSED -> resume: ACTIVE again, one incremental and one reconcile message.
      const resumed = await as.post(`${paused.path}/resume`);
      expect(resumed.status).toBe(200);
      expect(integrationSchema.parse(resumed.body)).toMatchObject({
        status: 'ACTIVE',
        pausedReason: null,
      });
      expect(sent(INTEGRATION_SYNC_QUEUE)).toEqual([
        { integrationId: paused.id, kind: 'incremental' },
      ]);
      expect(sent(INTEGRATION_BACKFILL_QUEUE)).toEqual([
        { integrationId: paused.id, kind: 'reconcile' },
      ]);
      expect((await eventsOf(paused.id)).at(-1)).toMatchObject({
        from: 'PAUSED',
        to: 'ACTIVE',
      });
      expect((await historyOf(paused.id)).at(-1)).toMatchObject({
        fromStatus: 'PAUSED',
        toStatus: 'ACTIVE',
      });

      // Unknown integration.
      expect(
        (await as.post(`${active.path.replace(active.id, randomUUID())}/pause`))
          .status,
      ).toBe(404);
    });

    it('S08 AS-68: two concurrent pauses of an ACTIVE integration give one 200, one 409, one history row and one event', async () => {
      const s = await seller();
      const t = await integrationIn(s);
      const results = await Promise.all([
        ctx.as(s.owner).post(`${t.path}/pause`),
        ctx.as(s.owner).post(`${t.path}/pause`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await historyOf(t.id)).toHaveLength(1);
      expect(await eventsOf(t.id)).toHaveLength(1);
      expect((await rowOf(t.id)).status).toBe('PAUSED');
    });

    it('S08 AS-68: a concurrent pause and resume of an ACTIVE integration leave one consistent outcome: every history row is a successful call and the status is the last one written', async () => {
      const s = await seller();
      // the 6 rounds each have their own integration, so they run side by side
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          const t = await integrationIn(s);
          const [p, r] = await Promise.all([
            ctx.as(s.owner).post(`${t.path}/pause`),
            ctx.as(s.owner).post(`${t.path}/resume`),
          ]);
          expect(p.status).toBe(200); // pause is legal from ACTIVE whatever the order
          expect([200, 409]).toContain(r.status);
          const history = await historyOf(t.id);
          // resume only succeeds when it ran after the pause; then there are two rows, otherwise exactly one.
          expect(history).toHaveLength(r.status === 200 ? 2 : 1);
          expect((await eventsOf(t.id)).length).toBe(history.length);
          expect((await rowOf(t.id)).status).toBe(history.at(-1)!.toStatus);
        }),
      );
    });
  });

  // ---- AS-69 ---------------------------------------------------------------------------------------------------

  describe('disconnect', () => {
    const registerWebhooks = async (t: { id: string; fake: FakeShopify }) => {
      const address = `${config.get('backend_host').replace(/\/+$/, '')}/api/integrations/${t.id}/webhooks`;
      for (const topic of [
        'products/update',
        'products/delete',
        'app/uninstalled',
      ]) {
        const res = await fetch(
          `${t.fake.baseUrl}/admin/api/${t.fake.apiVersion}/webhooks.json`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-shopify-access-token': t.fake.accessToken,
            },
            body: JSON.stringify({
              webhook: { topic, address, format: 'json' },
            }),
          },
        );
        expect(res.status).toBe(201);
      }
      expect(t.fake.webhookSubscriptions).toHaveLength(3);
    };

    it('S08 AS-69: DELETE answers 204, the status is DISCONNECTED with a history row and one event, credentials are erased, the store webhooks are removed, links and products stay, queued messages do nothing, and a repeat is 204 without a second event', async () => {
      const s = await seller();
      const t = await integrationIn(s);
      t.fake.addProduct({ title: 'Kept', stock: 3 });
      await engine.handle(backfillMsg(t.id));
      await registerWebhooks(t);
      const links = await db.query<Record<string, any>>(
        `SELECT * FROM "ExternalLink" WHERE "integrationId" = :id`,
        { type: QueryTypes.SELECT, replacements: { id: t.id } },
      );
      expect(links).toHaveLength(1);

      const res = await ctx.as(s.owner).delete(t.path);

      expect(res.status).toBe(204);
      const row = await rowOf(t.id);
      expect(row.status).toBe('DISCONNECTED');
      expect(row.credentialsSealed).toBeNull();
      expect(await historyOf(t.id)).toEqual([
        expect.objectContaining({
          fromStatus: 'ACTIVE',
          toStatus: 'DISCONNECTED',
          actorId: s.owner.id,
        }),
      ]);
      expect(await eventsOf(t.id)).toEqual([
        expect.objectContaining({
          from: 'ACTIVE',
          to: 'DISCONNECTED',
          reason: 'disconnected',
        }),
      ]);
      expect(t.fake.webhookSubscriptions).toHaveLength(0);
      const afterLinks = await db.query<Record<string, any>>(
        `SELECT l."localId", p."id" AS "productId" FROM "ExternalLink" l JOIN "Product" p ON p."id" = l."localId" WHERE l."integrationId" = :id`,
        { type: QueryTypes.SELECT, replacements: { id: t.id } },
      );
      expect(afterLinks).toHaveLength(1);

      // A message queued before the disconnect is acknowledged and does nothing: no provider call.
      t.fake.clearLog();
      expect(await engine.handle(backfillMsg(t.id))).toBe('ignored');
      expect(
        await engine.handle({ integrationId: t.id, kind: 'reconcile' }),
      ).toBe('ignored');
      expect(t.fake.requests).toHaveLength(0);

      // Repeat: 204, nothing new anywhere and no provider call.
      const again = await ctx.as(s.owner).delete(t.path);
      expect(again.status).toBe(204);
      expect(await historyOf(t.id)).toHaveLength(1);
      expect(await eventsOf(t.id)).toHaveLength(1);
      expect(t.fake.requests).toHaveLength(0);
    });

    it('S08 AS-69: a failing deregistration is attempted and tolerated: still 204, the integration is DISCONNECTED and the credentials are gone', async () => {
      const s = await seller();
      const t = await integrationIn(s);
      await registerWebhooks(t);
      t.fake.inject({
        match: (r) => r.method === 'DELETE',
        fault: { kind: 'status', status: 500 },
      });

      const res = await ctx.as(s.owner).delete(t.path);

      expect(res.status).toBe(204);
      expect(
        t.fake.requestsTo('DELETE', /\/webhooks\/\d+\.json$/).length,
      ).toBeGreaterThanOrEqual(1);
      expect(t.fake.webhookSubscriptions).toHaveLength(3);
      const row = await rowOf(t.id);
      expect(row.status).toBe('DISCONNECTED');
      expect(row.credentialsSealed).toBeNull();
      const deleteCalls = t.fake.requestsTo(
        'DELETE',
        /\/webhooks\/\d+\.json$/,
      ).length;
      expect((await ctx.as(s.owner).delete(t.path)).status).toBe(204);
      expect(
        t.fake.requestsTo('DELETE', /\/webhooks\/\d+\.json$/),
      ).toHaveLength(deleteCalls);
    });

    async function midRun(
      t: Awaited<ReturnType<typeof integrationIn>>,
      act: () => Promise<void>,
    ) {
      for (let i = 0; i < 6; i++)
        t.fake.addProduct({
          title: `P${i}`,
          stock: 1,
          updatedAt: new Date(ctx.clock.now().getTime() - (30 - i) * MIN),
        });
      const gate = t.fake.gate(
        (r) => r.path.endsWith('/products.json') && !!r.query.page_info,
        { once: true },
      );
      const running = engine.handle(backfillMsg(t.id));
      await gate.reached;
      const applied = async () =>
        Number(
          (
            await db.query<{ n: string }>(
              `SELECT count(*) AS n FROM "ExternalLink" WHERE "integrationId" = :id`,
              { type: QueryTypes.SELECT, replacements: { id: t.id } },
            )
          )[0].n,
        );
      expect(await applied()).toBe(2); // the first page of two is in
      await act();
      gate.release();
      const outcome = await running;
      const [run] = await db.query<Record<string, any>>(
        `SELECT * FROM "SyncRun" WHERE "integrationId" = :id`,
        { type: QueryTypes.SELECT, replacements: { id: t.id } },
      );
      return { outcome, applied: await applied(), run };
    }

    it('S08 AS-69: an in-flight run stops and writes nothing after the disconnect', async () => {
      const s = await seller();
      const t = await integrationIn(s, 'ACTIVE', { pageSize: 2 });
      const result = await midRun(t, async () => {
        expect((await ctx.as(s.owner).delete(t.path)).status).toBe(204);
      });
      expect(result.outcome).toBe('failed');
      expect(result.applied).toBe(2);
      expect(result.run.outcome).toBe('failed');
      expect((await rowOf(t.id)).status).toBe('DISCONNECTED');
    });

    it('S08 AS-69: a run whose integration is paused while a page is in flight ends at that checkpoint with integration_inactive and writes nothing more', async () => {
      const s = await seller();
      const t = await integrationIn(s, 'ACTIVE', { pageSize: 2 });
      const result = await midRun(t, async () => {
        expect((await ctx.as(s.owner).post(`${t.path}/pause`)).status).toBe(
          200,
        );
      });
      expect(result.outcome).toBe('failed');
      expect(result.applied).toBe(2);
      expect(result.run).toMatchObject({
        outcome: 'failed',
        detail: 'integration_inactive',
      });
    });
  });

  // ---- AS-70 ---------------------------------------------------------------------------------------------------

  describe('sync now', () => {
    const sync = (s: Seller, path: string, body: unknown) =>
      ctx
        .as(s.owner)
        .post(`${path}/sync`)
        .send(body as object);

    it('S08 AS-70: an incremental request answers 202 enqueued and queues one message; a second within a minute is 429 with Retry-After', async () => {
      const s = await seller();
      const t = await integrationIn(s);
      enqueue.mockClear();

      const res = await sync(s, t.path, { mode: 'incremental' });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ enqueued: true });
      expect(sent(INTEGRATION_SYNC_QUEUE)).toEqual([
        { integrationId: t.id, kind: 'incremental' },
      ]);

      const again = await sync(s, t.path, { mode: 'incremental' });
      expect(again.status).toBe(429);
      expect(again.body.code).toBe('rate_limited');
      expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
      expect(sent(INTEGRATION_SYNC_QUEUE)).toHaveLength(1);
    });

    it('S08 AS-70: while a pull holds the lease the answer is 202 enqueued false and nothing is queued', async () => {
      const s = await seller();
      const t = await integrationIn(s);
      expect(
        await cursors.claimLease(
          t.id,
          'product',
          'someone',
          5 * MIN,
          ctx.clock.now(),
        ),
      ).not.toBeNull();
      enqueue.mockClear();

      const res = await sync(s, t.path, { mode: 'incremental' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ enqueued: false });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('S08 AS-70: a backfill resets the cursor, goes to the backfill queue and is limited to one per hour; incremental is not affected by it', async () => {
      const s = await seller();
      const t = await integrationIn(s);
      t.fake.addProduct({
        title: 'One',
        stock: 1,
        updatedAt: new Date(ctx.clock.now().getTime() - 5 * MIN),
      });
      await engine.handle(backfillMsg(t.id));
      expect((await cursors.read(t.id, 'product'))!.watermark).not.toBeNull();
      enqueue.mockClear();

      const res = await sync(s, t.path, { mode: 'backfill' });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ enqueued: true });
      expect((await cursors.read(t.id, 'product'))!.watermark).toBeNull();
      expect(sent(INTEGRATION_BACKFILL_QUEUE)).toEqual([
        { integrationId: t.id, kind: 'backfill' },
      ]);
      expect(sent(INTEGRATION_SYNC_QUEUE)).toEqual([]);

      const again = await sync(s, t.path, { mode: 'backfill' });
      expect(again.status).toBe(429);
      expect(Number(again.headers['retry-after'])).toBeGreaterThan(60);
      expect(sent(INTEGRATION_BACKFILL_QUEUE)).toHaveLength(1);
      expect((await sync(s, t.path, { mode: 'incremental' })).status).toBe(202);
    });

    it('S08 AS-70: PAUSED, NEEDS_REAUTH and DISCONNECTED integrations answer 409 for both modes and the refusal does not use up the limit', async () => {
      const s = await seller();
      const paused = await integrationIn(s, 'PAUSED');
      const reauth = await integrationIn(s, 'NEEDS_REAUTH');
      const gone = await integrationIn(s, 'DISCONNECTED');
      enqueue.mockClear();
      for (const t of [paused, reauth, gone])
        for (const mode of ['incremental', 'backfill']) {
          const res = await sync(s, t.path, { mode });
          expect([t.id, mode, res.status]).toEqual([t.id, mode, 409]);
          expect(res.body.code).toBe('invalid_integration_transition');
        }
      expect(enqueue).not.toHaveBeenCalled();
      expect((await ctx.as(s.owner).post(`${paused.path}/resume`)).status).toBe(
        200,
      );
      enqueue.mockClear();
      expect((await sync(s, paused.path, { mode: 'incremental' })).status).toBe(
        202,
      );
      expect((await sync(s, paused.path, { mode: 'backfill' })).status).toBe(
        202,
      );
    });

    it('S08 AS-70: with the breaker open the answer is 202 enqueued false with reason breaker_open and nothing is queued', async () => {
      const s = await seller();
      const t = await integrationIn(s);
      await integrations.saveBreaker(t.id, {
        failures: 5,
        openUntil: new Date(ctx.clock.now().getTime() + 5 * MIN),
        halfOpen: false,
        attentionRaised: true,
      });
      enqueue.mockClear();

      const res = await sync(s, t.path, { mode: 'incremental' });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ enqueued: false, reason: 'breaker_open' });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('S08 AS-70: a mode outside the two values, an unknown field and a missing body are 400 validation_failed', async () => {
      const s = await seller();
      const t = await integrationIn(s);
      for (const body of [
        { mode: 'full' },
        { mode: 'incremental', extra: 1 },
        {},
        { mode: 5 },
      ]) {
        const res = await sync(s, t.path, body);
        expect([JSON.stringify(body), res.status]).toEqual([
          JSON.stringify(body),
          400,
        ]);
        expect(res.body.code).toBe('validation_failed');
        expect(Array.isArray(res.body.errors)).toBe(true);
      }
      expect((await ctx.as(s.owner).post(`${t.path}/sync`)).status).toBe(400);
    });
  });

  // ---- AS-71 ---------------------------------------------------------------------------------------------------

  describe('permissions and tenant isolation', () => {
    interface Route {
      name: string;
      method: 'get' | 'post' | 'delete';
      path: (t: { path: string }, s: Seller) => string;
      body?: object;
    }
    const routes: Route[] = [
      {
        name: 'list',
        method: 'get',
        path: (_t, s) => `/api/shops/${s.shopId}/integrations`,
      },
      { name: 'detail', method: 'get', path: (t) => t.path },
      {
        name: 'reconciliations',
        method: 'get',
        path: (t) => `${t.path}/reconciliations`,
      },
      {
        name: 'report',
        method: 'get',
        path: (t) => `${t.path}/reconciliations/${randomUUID()}`,
      },
      {
        name: 'quarantine list',
        method: 'get',
        path: (t) => `${t.path}/quarantine`,
      },
      {
        name: 'conflict list',
        method: 'get',
        path: (t) => `${t.path}/conflicts`,
      },
      {
        name: 'quarantine retry',
        method: 'post',
        path: (t) => `${t.path}/quarantine/${randomUUID()}/retry`,
      },
      {
        name: 'quarantine dismiss',
        method: 'post',
        path: (t) => `${t.path}/quarantine/${randomUUID()}/dismiss`,
      },
      {
        name: 'conflict dismiss',
        method: 'post',
        path: (t) => `${t.path}/conflicts/${randomUUID()}/dismiss`,
      },
      { name: 'pause', method: 'post', path: (t) => `${t.path}/pause` },
      { name: 'resume', method: 'post', path: (t) => `${t.path}/resume` },
      {
        name: 'sync',
        method: 'post',
        path: (t) => `${t.path}/sync`,
        body: { mode: 'incremental' },
      },
      { name: 'reconcile', method: 'post', path: (t) => `${t.path}/reconcile` },
      { name: 'disconnect', method: 'delete', path: (t) => t.path },
      {
        name: 'install',
        method: 'post',
        path: (_t, s) => `/api/shops/${s.shopId}/integrations/shopify/install`,
        body: { shopDomain: 'matrix-store.myshopify.com' },
      },
      {
        name: 'connect',
        method: 'post',
        path: (_t, s) => `/api/shops/${s.shopId}/integrations`,
        body: {
          provider: 'woocommerce',
          storeUrl: 'https://shop.example.com',
          consumerKey: 'ck',
          consumerSecret: 'cs',
        },
      },
    ];

    const call = (
      user: TestUser | null,
      route: Route,
      t: { path: string },
      s: Seller,
    ) => {
      const url = route.path(t, s);
      if (user === null) {
        const req = ctx.http()[route.method](url);
        return route.body ? req.send(route.body) : req;
      }
      const req = ctx.as(user)[route.method](url);
      return route.body ? req.send(route.body) : req;
    };

    async function team(s: Seller) {
      const out = {} as Record<FixtureRole, TestUser>;
      out.OWNER = s.owner;
      for (const role of ['ADMIN', 'STAFF', 'VIEWER'] as const) {
        const user = await ctx.newUser();
        await tenancy.addMember(s.shopId, user.id, role);
        out[role] = user;
      }
      return out;
    }

    it('S08 AS-71: OWNER and ADMIN succeed on every route they may use', async () => {
      const s = await seller();
      const users = await team(s);
      for (const role of ['OWNER', 'ADMIN'] as const) {
        const t = await integrationIn(s);
        const ok = async (name: string, status: number) => {
          const res = await call(
            users[role],
            routes.find((r) => r.name === name)!,
            t,
            s,
          );
          expect([role, name, res.status]).toEqual([role, name, status]);
        };
        for (const name of [
          'list',
          'detail',
          'reconciliations',
          'quarantine list',
          'conflict list',
        ])
          await ok(name, 200);
        await ok('sync', 202);
        await ok('reconcile', 202);
        await ok('pause', 200);
        await ok('resume', 200);
        await ok('install', 200);
        await ok('disconnect', 204);
        // These need a member of the right role to even reach their lookups: unknown ids are 404, never 403.
        for (const name of [
          'report',
          'quarantine retry',
          'quarantine dismiss',
          'conflict dismiss',
        ]) {
          const res = await call(
            users[role],
            routes.find((r) => r.name === name)!,
            t,
            s,
          );
          expect([role, name, res.status]).toEqual([role, name, 404]);
        }
      }
    });

    it('S08 AS-71: STAFF and VIEWER get 403 permission_denied on every route, an unauthenticated caller 401, and nothing changes', async () => {
      const s = await seller();
      const users = await team(s);
      const t = await integrationIn(s);
      const before = {
        row: (({ updatedAt, ...r }) => r)(await rowOf(t.id)),
        history: (await historyOf(t.id)).length,
      };
      enqueue.mockClear();
      for (const role of ['STAFF', 'VIEWER'] as const)
        for (const route of routes) {
          const res = await call(users[role], route, t, s);
          expect([role, route.name, res.status, res.body.code]).toEqual([
            role,
            route.name,
            403,
            'permission_denied',
          ]);
        }
      for (const route of routes) {
        const res = await call(null, route, t, s);
        expect([route.name, res.status]).toEqual([route.name, 401]);
      }
      expect({
        row: (({ updatedAt, ...r }) => r)(await rowOf(t.id)),
        history: (await historyOf(t.id)).length,
      }).toEqual(before);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('S08 AS-71: a member of another shop gets 404 shop_not_found on every route', async () => {
      const s = await seller();
      const t = await integrationIn(s);
      const other = await seller();
      for (const route of routes) {
        const res = await call(other.owner, route, t, s);
        expect([route.name, res.status, res.body.code]).toEqual([
          route.name,
          404,
          'shop_not_found',
        ]);
      }
    });

    it("S08 AS-71: another shop's owner using this shop's ids through their own path gets the same 404 as for ids that do not exist, and nothing changes", async () => {
      const s = await seller();
      const mine = await integrationIn(s);
      const other = await seller();
      const before = {
        row: (({ updatedAt, ...r }) => r)(await rowOf(mine.id)),
        history: (await historyOf(mine.id)).length,
        events: (await eventsOf(mine.id)).length,
      };
      enqueue.mockClear();
      const theirs = {
        ...other,
        path: `/api/shops/${other.shopId}/integrations/${mine.id}`,
      };
      const nothing = {
        ...other,
        path: `/api/shops/${other.shopId}/integrations/${randomUUID()}`,
      };
      for (const route of routes.filter(
        (r) => !['list', 'install', 'connect'].includes(r.name),
      )) {
        const a = await call(other.owner, route, theirs, other);
        const b = await call(other.owner, route, nothing, other);
        expect([route.name, a.status]).toEqual([route.name, 404]);
        expect([route.name, b.status]).toEqual([route.name, 404]);
        expect([route.name, problemShape(a.body)]).toEqual([
          route.name,
          problemShape(b.body),
        ]);
      }
      expect({
        row: (({ updatedAt, ...r }) => r)(await rowOf(mine.id)),
        history: (await historyOf(mine.id)).length,
        events: (await eventsOf(mine.id)).length,
      }).toEqual(before);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('S08 AS-71: a SUSPENDED or DELETING shop refuses the routes with the status gate and nothing changes', async () => {
      for (const [status, code, http] of [
        ['SUSPENDED', 'shop_suspended', 403],
        ['DELETING', 'shop_offboarding', 409],
      ] as const) {
        const s = await seller();
        const t = await integrationIn(s);
        enqueue.mockClear();
        await tenancy.setShopStatus(s.shopId, status);
        for (const name of [
          'pause',
          'resume',
          'sync',
          'reconcile',
          'disconnect',
          'install',
          'connect',
        ]) {
          const route = routes.find((r) => r.name === name)!;
          const res = await call(s.owner, route, t, s);
          expect([status, name, res.status, res.body.code]).toEqual([
            status,
            name,
            http,
            code,
          ]);
        }
        expect(await historyOf(t.id)).toHaveLength(0);
        expect((await rowOf(t.id)).status).toBe('ACTIVE');
        expect(enqueue).not.toHaveBeenCalled();
      }
    });
  });

  // ---- AS-72 ---------------------------------------------------------------------------------------------------

  describe('validation and errors', () => {
    const expectValidation = (res: any, label: string) => {
      expect([label, res.status]).toEqual([label, 400]);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.errors.length).toBeGreaterThan(0);
      for (const e of res.body.errors) {
        expect(typeof e.field).toBe('string');
        expect(typeof e.code).toBe('string');
      }
    };
    const expectProblem = (res: any) => {
      expect(res.headers['content-type']).toContain('application/problem+json');
      for (const key of [
        'type',
        'title',
        'status',
        'detail',
        'instance',
        'requestId',
        'code',
      ])
        expect([key, res.body[key] !== undefined]).toEqual([key, true]);
      expect(res.body.status).toBe(res.status);
    };

    it('S08 AS-72: unknown, missing and mistyped body fields are 400 validation_failed with errors on install, connect and sync', async () => {
      const s = await seller();
      const t = await integrationIn(s);
      const as = ctx.as(s.owner);
      const base = `/api/shops/${s.shopId}/integrations`;
      const cases: Array<[string, string, object]> = [
        [
          'install unknown field',
          `${base}/shopify/install`,
          { shopDomain: 'a.myshopify.com', extra: true },
        ],
        ['install missing field', `${base}/shopify/install`, {}],
        ['install wrong type', `${base}/shopify/install`, { shopDomain: 5 }],
        [
          'install bad domain',
          `${base}/shopify/install`,
          { shopDomain: 'evil.example.com' },
        ],
        [
          'connect unknown field',
          base,
          {
            provider: 'woocommerce',
            storeUrl: 'https://a.example.com',
            consumerKey: 'k',
            consumerSecret: 's',
            fake: true,
          },
        ],
        [
          'connect missing field',
          base,
          {
            provider: 'woocommerce',
            storeUrl: 'https://a.example.com',
            consumerKey: 'k',
          },
        ],
        [
          'connect wrong type',
          base,
          {
            provider: 'woocommerce',
            storeUrl: 'https://a.example.com',
            consumerKey: 5,
            consumerSecret: 's',
          },
        ],
        [
          'connect old credentials field',
          base,
          { provider: 'woocommerce', credentials: { a: 1 } },
        ],
        [
          'connect provider fake',
          base,
          { provider: 'fake', storeUrl: 'https://a.example.com' },
        ],
        [
          'sync unknown field',
          `${t.path}/sync`,
          { mode: 'incremental', extra: 1 },
        ],
        ['sync wrong type', `${t.path}/sync`, { mode: 3 }],
      ];
      for (const [label, url, body] of cases) {
        const res = await as.post(url).send(body);
        expectValidation(res, label);
        expectProblem(res);
      }
      // The echoed error never carries the submitted secret.
      const leaked = await as.post(base).send({
        provider: 'woocommerce',
        storeUrl: 'https://a.example.com',
        consumerKey: 'k',
        consumerSecret: 5,
        token: 'TOP-SECRET-VALUE',
      });
      expect(JSON.stringify(leaked.body)).not.toContain('TOP-SECRET-VALUE');
    });

    it('S08 AS-72: path ids that are not UUIDs and malformed queries are 400 validation_failed', async () => {
      const s = await seller();
      const t = await integrationIn(s);
      const as = ctx.as(s.owner);
      const base = `/api/shops/${s.shopId}/integrations`;
      const gets = [
        `${base}/not-a-uuid`,
        `${base}/not-a-uuid/reconciliations`,
        `${t.path}/reconciliations/not-a-uuid`,
        `${t.path}/quarantine?status=BOGUS`,
        `${t.path}/quarantine?limit=0`,
        `${t.path}/conflicts?status=BOGUS`,
        `${t.path}/conflicts?limit=abc`,
        `${t.path}/reconciliations?limit=101`,
        `${base}?limit=abc`,
      ];
      for (const url of gets) {
        const res = await as.get(url);
        expectValidation(res, url);
        expectProblem(res);
      }
      const posts = [
        `${base}/not-a-uuid/pause`,
        `${base}/not-a-uuid/resume`,
        `${base}/not-a-uuid/reconcile`,
        `${t.path}/quarantine/not-a-uuid/retry`,
        `${t.path}/quarantine/not-a-uuid/dismiss`,
        `${t.path}/conflicts/not-a-uuid/dismiss`,
      ];
      for (const url of posts) expectValidation(await as.post(url), url);
      expectValidation(await as.delete(`${base}/not-a-uuid`), 'delete');
      expectValidation(
        await as.post(`${base}/not-a-uuid/sync`).send({ mode: 'incremental' }),
        'sync',
      );
    });

    it('S08 AS-72: every error is problem+json with a request id; a 404 and a 409 have the same shape; a 5xx detail is generic and leaks neither SQL nor an exception message', async () => {
      const s = await seller();
      const t = await integrationIn(s, 'PAUSED');
      const as = ctx.as(s.owner);
      const missing = await as.get(`${t.path.replace(t.id, randomUUID())}`);
      expect(missing.status).toBe(404);
      expectProblem(missing);
      const conflict = await as.post(`${t.path}/pause`);
      expect(conflict.status).toBe(409);
      expectProblem(conflict);
      const unauthorised = await ctx.http().get(t.path);
      expect(unauthorised.status).toBe(401);
      expectProblem(unauthorised);
      expect(missing.body.requestId).not.toBe(conflict.body.requestId);

      const core = ctx.app
        .select(IntegrationsModule)
        .get<IntegrationRepository>(INTEGRATION_REPOSITORY, { strict: true });
      jest
        .spyOn(core, 'findInShop')
        .mockRejectedValue(
          new Error(
            'SELECT * FROM "Integration" WHERE "credentialsSealed" = \'boom\' failed at provider https://secret.example',
          ),
        );
      const failing = await as.get(t.path);
      expect(failing.status).toBe(500);
      expectProblem(failing);
      const text = JSON.stringify(failing.body);
      for (const fragment of [
        'SELECT',
        'credentialsSealed',
        'boom',
        'secret.example',
        'stack',
      ])
        expect(text).not.toContain(fragment);
    });
  });
});
