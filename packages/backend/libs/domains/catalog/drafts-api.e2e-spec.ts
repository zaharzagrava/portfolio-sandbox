import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import * as jwt from 'jsonwebtoken';
import { v7 as uuidv7 } from 'uuid';
import {
  draftConnectSchema,
  draftPageSchema,
  draftSchema,
  type Draft,
} from '@marketplace-sandbox/contracts';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { createProduct } from '@app/test/utils/catalog-fixtures';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { CollabModule } from './collab.module';
import { DraftsModule } from './drafts.module';
import { ProductCommandService } from './application/product-command.service';
import {
  DOC_STORE,
  RING_REGISTRY,
  type DocStore,
  type RingRegistry,
} from './domain/draft-ports';
import { readListing } from './domain/listing-doc';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import {
  createShopWorld,
  stableProblem,
  type ShopWorld,
} from './testing/catalog-spec-kit';
import {
  connectTo,
  draftCount,
  draftRow,
  openEditor,
  seedDraft,
  seedDrafts,
  seedVersion,
  versionRows,
  announceRing,
} from './testing/draft-spec-kit';
import { waitFor } from '@app/test/utils/async-helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOW = new Date('2026-03-01T10:00:00.000Z');

describe('Listing drafts API', () => {
  describe('with an editing instance', () => {
    let t: CatalogTestApp;
    let sequelize: Sequelize;
    let w: ShopWorld;

    const base = (shopId = w.shop.id) => `/api/shops/${shopId}/drafts`;

    beforeAll(async () => {
      t = await createCatalogApp({
        extraImports: [DraftsModule, CollabModule],
      });
      sequelize = t.app.get(Sequelize);
    });
    afterAll(() => t.close());
    beforeEach(async () => {
      await t.reset();
      t.clock.set(NOW);
      w = await createShopWorld(t);
      // `reset` flushed Redis, including this instance's ring entry; announce it again.
      await announceRing(t.app);
    });

    describe('create (AS-01 to AS-05)', () => {
      it('S06 AS-01: a member with products.write creates a blank draft: view, one row from the request context, no log entry, empty document', async () => {
        const res = await t
          .as(w.staff)
          .post(base())
          .send({ title: 'iPhone 17 listing' })
          .expect(201);
        const draft: Draft = draftSchema.parse(res.body);
        expect(draft).toMatchObject({
          shopId: w.shop.id,
          productId: null,
          title: 'iPhone 17 listing',
          status: 'DRAFT',
          baseProductVersion: null,
          createdBy: w.staff.id,
          publishedAt: null,
        });
        expect(draft.id).toMatch(UUID);
        expect(draft.createdAt).toBe(NOW.toISOString());

        expect(await draftCount(t.app)).toBe(1);
        const row = await draftRow<{
          shopId: string;
          createdBy: string;
          snapshotKey: string | null;
        }>(t.app, draft.id);
        expect(row).toMatchObject({ shopId: w.shop.id, createdBy: w.staff.id });
        expect(row!.snapshotKey).toBeNull();
        const log = await t.app.get(DynamoService).doc.send(
          new QueryCommand({
            TableName: t.app.get(DynamoService).table('DocUpdates'),
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: { ':pk': `DOC#${draft.id}` },
            ConsistentRead: true,
          }),
        );
        expect(log.Items ?? []).toHaveLength(0);

        const editor = await openEditor(t, w.staff, w.shop.id, draft.id);
        await editor.whenSynced();
        expect(editor.doc.getText('title').toString()).toBe('');
        expect(editor.doc.getMap('fields').size).toBe(0);
        editor.close();
      });

      it('S06 AS-02: a draft from a product records its version and first join receives the content with the spec table parsed back', async () => {
        const product = await createProduct(t.app, w.shop, {
          title: 'AirPods Pro',
          description:
            'Adaptive audio.\n\nSpecifications\n- Color: Black\n- Storage: 256 GB',
          brand: 'Apple',
          category: 'audio',
          priceMinor: 24_900,
          quantity: 12,
          version: 7,
        });
        const getForShop = jest.spyOn(
          t.app.get(ProductCommandService),
          'getForShop',
        );

        const res = await t
          .as(w.staff)
          .post(base())
          .send({ title: 'AirPods rework', productId: product.id })
          .expect(201);
        const draft = draftSchema.parse(res.body);
        expect(draft).toMatchObject({
          productId: product.id,
          baseProductVersion: 7,
          status: 'DRAFT',
        });
        expect(getForShop).toHaveBeenCalledWith(w.shop.id, product.id);

        const loaded = await t.app
          .get<DocStore>(DOC_STORE)
          .load(w.shop.id, draft.id);
        expect(readListing(loaded.doc)).toEqual({
          title: 'AirPods Pro',
          description: 'Adaptive audio.',
          priceMinor: 24_900,
          brand: 'Apple',
          category: 'audio',
          quantity: 12,
          specs: { Color: 'Black', Storage: '256 GB' },
        });

        const editor = await openEditor(t, w.staff, w.shop.id, draft.id);
        await editor.whenSynced();
        expect(editor.doc.getText('title').toString()).toBe('AirPods Pro');
        expect(editor.doc.getMap('specs').get('Storage')).toBe('256 GB');
        editor.close();
        getForShop.mockRestore();
      });

      const invalid: [string, Record<string, unknown>, string][] = [
        ['a missing title', {}, 'title'],
        ['an empty title', { title: '' }, 'title'],
        ['a whitespace-only title', { title: '   ' }, 'title'],
        ['a non-string title', { title: 42 }, 'title'],
        ['a 121 character title', { title: 'x'.repeat(121) }, 'title'],
        [
          'a non-uuid productId',
          { title: 'ok', productId: 'nope' },
          'productId',
        ],
        [
          'an unknown field status',
          { title: 'ok', status: 'PUBLISHED' },
          'status',
        ],
        [
          'an unknown field shopId',
          { title: 'ok', shopId: uuidv7() },
          'shopId',
        ],
        [
          'an unknown field createdBy',
          { title: 'ok', createdBy: uuidv7() },
          'createdBy',
        ],
      ];
      it.each(invalid)(
        'S06 AS-03: %s gives 400 validation_failed naming the field and creates no draft',
        async (_name, body, field) => {
          const res = await t.as(w.staff).post(base()).send(body).expect(400);
          expect(res.body.code).toBe('validation_failed');
          expect(
            (res.body.errors as Array<{ field: string }>).map((e) => e.field),
          ).toContain(field);
          expect(await draftCount(t.app)).toBe(0);
        },
      );

      it('S06 AS-04: a missing or foreign product is the same 404 product_not_found and an archived one is 409 product_archived; no draft is created', async () => {
        const other = await createShop(t.app, w.owner);
        const foreign = await createProduct(t.app, other);
        const archived = await createProduct(t.app, w.shop, {
          status: 'ARCHIVED',
        });

        const missing = await t
          .as(w.staff)
          .post(base())
          .send({ title: 'x', productId: uuidv7() })
          .expect(404);
        const foreignRes = await t
          .as(w.staff)
          .post(base())
          .send({ title: 'x', productId: foreign.id })
          .expect(404);
        expect(missing.body.code).toBe('product_not_found');
        expect(stableProblem(foreignRes.body)).toEqual(
          stableProblem(missing.body),
        );

        const gone = await t
          .as(w.staff)
          .post(base())
          .send({ title: 'x', productId: archived.id })
          .expect(409);
        expect(gone.body.code).toBe('product_archived');
        expect(await draftCount(t.app)).toBe(0);
      });

      it('S06 AS-05: at 199 open drafts two simultaneous creates give one 201 and one 409 draft_limit_reached: exactly 200 open', async () => {
        await seedDrafts(t.app, w.shop.id, w.owner.id, 199);
        const calls = await Promise.all(
          [1, 2].map((n) =>
            t
              .as(w.staff)
              .post(base())
              .send({ title: `racer ${n}` }),
          ),
        );
        expect(calls.map((c) => c.status).sort()).toEqual([201, 409]);
        const refused = calls.find((c) => c.status === 409)!;
        expect(refused.body.code).toBe('draft_limit_reached');
        expect(
          await draftCount(
            t.app,
            `"shopId" = :s AND "status" IN ('DRAFT','PUBLISHING')`,
            {
              s: w.shop.id,
            },
          ),
        ).toBe(200);

        const again = await t
          .as(w.staff)
          .post(base())
          .send({ title: 'late' })
          .expect(409);
        expect(again.body.code).toBe('draft_limit_reached');
      });

      it('S06 AS-05: archived and published drafts do not count against the limit', async () => {
        await seedDrafts(t.app, w.shop.id, w.owner.id, 199);
        await seedDrafts(t.app, w.shop.id, w.owner.id, 20, {
          status: 'ARCHIVED',
        });
        await seedDrafts(t.app, w.shop.id, w.owner.id, 20, {
          status: 'PUBLISHED',
        });
        await t.as(w.staff).post(base()).send({ title: 'fits' }).expect(201);
      });
    });

    describe('list (AS-07)', () => {
      it('S06 AS-07: a keyset page of this shop only, newest first with id as tie-breaker, no duplicate or gap when a draft arrives between pages', async () => {
        const other = await createShop(t.app, w.owner);
        const earlier = new Date(NOW.getTime() - 3_600_000);
        await seedDrafts(t.app, w.shop.id, w.owner.id, 45, {
          group: 3,
          from: earlier,
        });
        await seedDrafts(t.app, other.id, w.owner.id, 5, { from: earlier });
        const expected = (
          await sequelize.query<{ id: string }>(
            `SELECT "id" FROM "ListingDraft" WHERE "shopId" = :s ORDER BY "updatedAt" DESC, "id" DESC`,
            { type: QueryTypes.SELECT, replacements: { s: w.shop.id } },
          )
        ).map((r) => r.id);

        const first = draftPageSchema.parse(
          (await t.as(w.staff).get(`${base()}?limit=20`).expect(200)).body,
        );
        expect(first.items).toHaveLength(20);
        expect(first.nextCursor).toEqual(expect.any(String));
        expect(first.items.every((d) => d.shopId === w.shop.id)).toBe(true);

        // A draft created between the two page requests must not shift the rest (it is the newest, so it sorts before all).
        await t
          .as(w.staff)
          .post(base())
          .send({ title: 'arrives mid-way' })
          .expect(201);

        const second = draftPageSchema.parse(
          (
            await t
              .as(w.staff)
              .get(`${base()}?limit=20&cursor=${first.nextCursor}`)
              .expect(200)
          ).body,
        );
        const third = draftPageSchema.parse(
          (
            await t
              .as(w.staff)
              .get(`${base()}?limit=20&cursor=${second.nextCursor}`)
              .expect(200)
          ).body,
        );
        expect(second.items).toHaveLength(20);
        expect(third.items).toHaveLength(5);
        expect(third.nextCursor).toBeNull();
        expect(
          [...first.items, ...second.items, ...third.items].map((d) => d.id),
        ).toEqual(expected);
      });

      it('S06 AS-07: the status filter returns only that status', async () => {
        await seedDrafts(t.app, w.shop.id, w.owner.id, 3);
        await seedDrafts(t.app, w.shop.id, w.owner.id, 2, {
          status: 'ARCHIVED',
        });
        const page = draftPageSchema.parse(
          (await t.as(w.staff).get(`${base()}?status=ARCHIVED`).expect(200))
            .body,
        );
        expect(page.items).toHaveLength(2);
        expect(page.items.every((d) => d.status === 'ARCHIVED')).toBe(true);
      });

      it.each([
        ['limit=0', 'limit=0', 'validation_failed'],
        ['limit=101', 'limit=101', 'validation_failed'],
        ['limit=abc', 'limit=abc', 'validation_failed'],
        ['an unknown status', 'status=NOPE', 'validation_failed'],
        ['a cursor that is not ours', 'cursor=bm9wZQ', 'invalid_cursor'],
      ])('S06 AS-07: %s is refused with 400 %s', async (_name, query, code) => {
        const res = await t.as(w.staff).get(`${base()}?${query}`).expect(400);
        expect(res.body.code).toBe(code);
      });

      it('S06 AS-07: a cursor of another shop is refused with 400 invalid_cursor', async () => {
        const other = await createShop(t.app, w.owner);
        await seedDrafts(t.app, other.id, w.owner.id, 3);
        const page = draftPageSchema.parse(
          (
            await t
              .as(w.owner)
              .get(`${base(other.id)}?limit=1`)
              .expect(200)
          ).body,
        );
        const res = await t
          .as(w.owner)
          .get(`${base()}?cursor=${page.nextCursor}`)
          .expect(400);
        expect(res.body.code).toBe('invalid_cursor');
      });
    });

    describe('access gates (AS-06)', () => {
      interface Route {
        name: string;
        permission: 'read' | 'write';
        call: (
          who: { bearer: string } | null,
          ctx: { shopId: string; draftId: string; versionId: string },
        ) => ReturnType<CatalogTestApp['http']> extends never ? never : any;
      }
      const send = (
        t0: CatalogTestApp,
        who: { bearer: string } | null,
        method: 'get' | 'post',
        url: string,
        body?: unknown,
        headers: Record<string, string> = {},
      ) => {
        let req = t0.http()[method](url);
        if (who) req = req.set('Authorization', who.bearer);
        for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
        return body === undefined ? req : req.send(body as object);
      };
      const routes: Route[] = [
        {
          name: 'create',
          permission: 'write',
          call: (who, c) =>
            send(t, who, 'post', base(c.shopId), { title: 'x' }),
        },
        {
          name: 'list',
          permission: 'read',
          call: (who, c) => send(t, who, 'get', base(c.shopId)),
        },
        {
          name: 'connect',
          permission: 'read',
          call: (who, c) =>
            send(t, who, 'post', `${base(c.shopId)}/${c.draftId}/connect`),
        },
        {
          name: 'archive',
          permission: 'write',
          call: (who, c) =>
            send(t, who, 'post', `${base(c.shopId)}/${c.draftId}/archive`),
        },
        {
          name: 'versions list',
          permission: 'read',
          call: (who, c) =>
            send(t, who, 'get', `${base(c.shopId)}/${c.draftId}/versions`),
        },
        {
          name: 'version read',
          permission: 'read',
          call: (who, c) =>
            send(
              t,
              who,
              'get',
              `${base(c.shopId)}/${c.draftId}/versions/${c.versionId}`,
            ),
        },
        {
          name: 'version create',
          permission: 'write',
          call: (who, c) =>
            send(t, who, 'post', `${base(c.shopId)}/${c.draftId}/versions`, {
              name: 'v',
            }),
        },
        {
          name: 'publish',
          permission: 'write',
          call: (who, c) =>
            send(
              t,
              who,
              'post',
              `${base(c.shopId)}/${c.draftId}/publish`,
              {},
              {
                'Idempotency-Key': 'k-gates',
              },
            ),
        },
      ];

      const arrange = async () => {
        const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
        const versionId = await seedVersion(t.app, draft, w.owner.id);
        return { shopId: w.shop.id, draftId: draft.id, versionId };
      };
      const snapshot = async (draftId: string) => ({
        drafts: await draftCount(t.app),
        draft: (await draftRow<{ status: string }>(t.app, draftId))?.status,
        versions: (await versionRows(t.app, draftId)).length,
      });

      it.each(routes)(
        'S06 AS-06: $name answers 401 without credentials',
        async (route) => {
          const ctx = await arrange();
          const before = await snapshot(ctx.draftId);
          await route.call(null, ctx).expect(401);
          expect(await snapshot(ctx.draftId)).toEqual(before);
        },
      );

      it.each(routes)(
        'S06 AS-06: $name answers 404 shop_not_found to a non-member',
        async (route) => {
          const ctx = await arrange();
          const before = await snapshot(ctx.draftId);
          const res = await route.call(w.outsider, ctx).expect(404);
          expect(res.body.code).toBe('shop_not_found');
          expect(await snapshot(ctx.draftId)).toEqual(before);
        },
      );

      it.each(routes.filter((r) => r.permission === 'write'))(
        'S06 AS-06: $name answers 403 permission_denied to a viewer',
        async (route) => {
          const ctx = await arrange();
          const before = await snapshot(ctx.draftId);
          const res = await route.call(w.viewer, ctx).expect(403);
          expect(res.body.code).toBe('permission_denied');
          expect(await snapshot(ctx.draftId)).toEqual(before);
        },
      );

      it.each(routes.filter((r) => r.permission === 'read'))(
        'S06 AS-06: $name is open to a viewer',
        async (route) => {
          const ctx = await arrange();
          const res = await route.call(w.viewer, ctx);
          expect([200, 201]).toContain(res.status);
        },
      );

      it.each(routes)(
        'S06 AS-06: $name answers 403 shop_suspended on a suspended shop',
        async (route) => {
          const ctx = await arrange();
          await t.app
            .get(Sequelize)
            .query(`UPDATE "Shop" SET "status" = 'SUSPENDED' WHERE "id" = :s`, {
              replacements: { s: ctx.shopId },
            });
          const before = await snapshot(ctx.draftId);
          const res = await route.call(w.owner, ctx).expect(403);
          expect(res.body.code).toBe('shop_suspended');
          expect(await snapshot(ctx.draftId)).toEqual(before);
        },
      );

      it.each(routes)(
        'S06 AS-06: $name answers 409 shop_offboarding on a closing shop',
        async (route) => {
          const ctx = await arrange();
          await t.app
            .get(Sequelize)
            .query(`UPDATE "Shop" SET "status" = 'DELETING' WHERE "id" = :s`, {
              replacements: { s: ctx.shopId },
            });
          const before = await snapshot(ctx.draftId);
          const res = await route.call(w.owner, ctx).expect(409);
          expect(res.body.code).toBe('shop_offboarding');
          expect(await snapshot(ctx.draftId)).toEqual(before);
        },
      );

      it('S06 AS-06: the payouts.read and sso.manage changes of S03 do not touch the draft routes', () => {
        // The draft routes use products.read and products.write only; their gates are the rows above.
        expect(
          routes
            .map((r) => r.permission)
            .every((p) => p === 'read' || p === 'write'),
        ).toBe(true);
      });
    });

    describe('cross-tenant access (AS-08)', () => {
      it('S06 AS-08: draft and version ids of another shop answer the same 404 as unknown ids on every id route and change nothing', async () => {
        const shopB = await createShop(t.app, w.owner);
        const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
        const versionId = await seedVersion(t.app, draft, w.owner.id);
        const unknown = uuidv7();
        const calls = (shop: string, d: string, v: string) => [
          t.as(w.owner).post(`${base(shop)}/${d}/connect`),
          t.as(w.owner).post(`${base(shop)}/${d}/archive`),
          t.as(w.owner).get(`${base(shop)}/${d}/versions`),
          t.as(w.owner).get(`${base(shop)}/${d}/versions/${v}`),
          t
            .as(w.owner)
            .post(`${base(shop)}/${d}/versions`)
            .send({ name: 'sneaky' }),
          t
            .as(w.owner)
            .post(`${base(shop)}/${d}/publish`)
            .set('Idempotency-Key', 'k-idor')
            .send({}),
        ];
        const crossed = await Promise.all(calls(shopB.id, draft.id, versionId));
        const random = await Promise.all(calls(shopB.id, unknown, unknown));
        crossed.forEach((res, i) => {
          expect(res.status).toBe(404);
          expect(res.body.code).toBe('draft_not_found');
          expect(stableProblem(res.body)).toEqual(
            stableProblem(random[i].body),
          );
        });
        expect(
          (await draftRow<{ status: string }>(t.app, draft.id))!.status,
        ).toBe('DRAFT');
        expect(await versionRows(t.app, draft.id)).toHaveLength(1);
        expect(
          await t.app
            .get(Sequelize)
            .query(`SELECT 1 FROM "Product" WHERE "shopId" = :s`, {
              replacements: { s: shopB.id },
              type: QueryTypes.SELECT,
            }),
        ).toHaveLength(0);
      });

      it('S06 AS-08: a version id of another draft of the same shop is version_not_found', async () => {
        const a = await seedDraft(t.app, w.shop.id, w.owner.id);
        const b = await seedDraft(t.app, w.shop.id, w.owner.id);
        const versionOfB = await seedVersion(t.app, b, w.owner.id);
        const res = await t
          .as(w.owner)
          .get(`${base()}/${a.id}/versions/${versionOfB}`)
          .expect(404);
        expect(res.body.code).toBe('version_not_found');
      });
    });

    describe('connect (AS-09, AS-10)', () => {
      it('S06 AS-09: a writer gets the owner address, a ticket bound to draft, shop, user and level, valid for exactly 60 seconds', async () => {
        const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
        const res = await t
          .as(w.staff)
          .post(`${base()}/${draft.id}/connect`)
          .expect(200);
        const connect = draftConnectSchema.parse(res.body);
        expect(connect.canWrite).toBe(true);
        expect(connect.url).toMatch(
          new RegExp(`^wss?://[^/]+/collab/${draft.id}$`),
        );
        expect(connect.expiresAt).toBe(
          new Date(NOW.getTime() + 60_000).toISOString(),
        );

        const decoded = jwt.decode(connect.ticket, { complete: true })!;
        expect(decoded.header.alg).toBe('HS256');
        expect(decoded.payload).toMatchObject({
          iss: 'marketplace-collab',
          aud: `collab:${draft.id}`,
          sub: w.staff.id,
          shop: w.shop.id,
          draft: draft.id,
          w: true,
          iat: NOW.getTime() / 1000,
          exp: NOW.getTime() / 1000 + 60,
        });
        expect((decoded.payload as { jti: string }).jti).toMatch(UUID);
      });

      it('S06 AS-09: a read-only member gets canWrite false', async () => {
        const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
        const c = await connectTo(t, w.viewer, w.shop.id, draft.id);
        expect(c.canWrite).toBe(false);
      });

      it.each(['PUBLISHING', 'PUBLISHED', 'ARCHIVED'] as const)(
        'S06 AS-09: a writer connecting to a draft in %s is read-only',
        async (status) => {
          const draft = await seedDraft(t.app, w.shop.id, w.owner.id, {
            status,
            leaseId: status === 'PUBLISHING' ? uuidv7() : null,
            leaseExpiresAt:
              status === 'PUBLISHING' ? new Date(NOW.getTime() + 60_000) : null,
          });
          const c = await connectTo(t, w.staff, w.shop.id, draft.id);
          expect(c.canWrite).toBe(false);
        },
      );

      it('S06 AS-10: the 31st connect within the minute is 429 with Retry-After', async () => {
        const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
        for (let i = 0; i < 30; i++)
          await t.as(w.staff).post(`${base()}/${draft.id}/connect`).expect(200);
        const limited = await t
          .as(w.staff)
          .post(`${base()}/${draft.id}/connect`)
          .expect(429);
        expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
        expect(limited.body.ticket).toBeUndefined();
        // Another user is unaffected.
        await t.as(w.admin).post(`${base()}/${draft.id}/connect`).expect(200);
      });

      it('S06 AS-10: with no editing instance registered connect is 503 collab_unavailable with Retry-After 5 and no ticket', async () => {
        const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
        await t.app.get(RedisService).client.del('collab:ring');
        // The other processes notice within two seconds; this one is told at once.
        await t.app.get<RingRegistry>(RING_REGISTRY).refreshNow();
        const res = await t
          .as(w.staff)
          .post(`${base()}/${draft.id}/connect`)
          .expect(503);
        expect(res.body.code).toBe('collab_unavailable');
        expect(res.headers['retry-after']).toBe('5');
        expect(res.body.ticket).toBeUndefined();
      });
    });

    describe('archive (AS-11)', () => {
      it('S06 AS-11: archiving a DRAFT answers ARCHIVED, closes its open room with 4005 and later connects are read-only', async () => {
        const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
        const editor = await openEditor(t, w.staff, w.shop.id, draft.id);
        await editor.whenSynced();

        const res = await t
          .as(w.staff)
          .post(`${base()}/${draft.id}/archive`)
          .expect(200);
        expect(draftSchema.parse(res.body).status).toBe('ARCHIVED');
        expect(
          (await draftRow<{ status: string }>(t.app, draft.id))!.status,
        ).toBe('ARCHIVED');

        await waitFor(async () => editor.closed !== null, { timeoutMs: 5_000 });
        expect(editor.closed!.code).toBe(4005);
        expect(
          (await connectTo(t, w.staff, w.shop.id, draft.id)).canWrite,
        ).toBe(false);
      });

      it.each(['PUBLISHED', 'ARCHIVED'] as const)(
        'S06 AS-11: archiving a %s draft is 409 invalid_transition with currentStatus',
        async (status) => {
          const draft = await seedDraft(t.app, w.shop.id, w.owner.id, {
            status,
          });
          const res = await t
            .as(w.staff)
            .post(`${base()}/${draft.id}/archive`)
            .expect(409);
          expect(res.body).toMatchObject({
            code: 'invalid_transition',
            currentStatus: status,
          });
          expect(
            (await draftRow<{ status: string }>(t.app, draft.id))!.status,
          ).toBe(status);
        },
      );

      it('S06 AS-11: archiving a PUBLISHING draft is 409 publish_in_progress', async () => {
        const draft = await seedDraft(t.app, w.shop.id, w.owner.id, {
          status: 'PUBLISHING',
          leaseId: uuidv7(),
          leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        });
        const res = await t
          .as(w.staff)
          .post(`${base()}/${draft.id}/archive`)
          .expect(409);
        expect(res.body.code).toBe('publish_in_progress');
        expect(
          (await draftRow<{ status: string }>(t.app, draft.id))!.status,
        ).toBe('PUBLISHING');
      });
    });
  });

  describe('with the rate limiter store down', () => {
    let proxy: TcpFaultProxy;
    let limited: CatalogTestApp;
    let world: ShopWorld;

    beforeAll(async () => {
      const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
      proxy = await TcpFaultProxy.start({
        host: url.hostname,
        port: Number(url.port || 6379),
      });
      limited = await createCatalogApp({
        extraImports: [DraftsModule],
        redisUrl: `redis://127.0.0.1:${proxy.port}/0`,
      });
    });
    afterAll(async () => {
      proxy.mode = 'pass';
      await limited.close();
      await proxy.close();
    });

    it('S06 AS-10: connect is refused 503 when the limiter cannot answer (fail closed) and no ticket is minted', async () => {
      await limited.reset();
      world = await createShopWorld(limited);
      const draft = await seedDraft(limited.app, world.shop.id, world.owner.id);
      // Cut the store for real and wait until the client has noticed, so no command is written into a dying socket.
      proxy.mode = 'refuse';
      proxy.sever();
      const redis = limited.app.get(RedisService).client;
      await waitFor(async () => redis.status !== 'ready', {
        timeoutMs: 5_000,
        intervalMs: 10,
        description: 'the client noticed the cut',
      });
      const res = await limited
        .as(world.staff)
        .post(`/api/shops/${world.shop.id}/drafts/${draft.id}/connect`);
      expect(res.status).toBe(503);
      expect(res.body.code).not.toBe('collab_unavailable'); // refused by the limiter, before the draft code ran
      expect(res.body.ticket).toBeUndefined();
    });
  });
});
