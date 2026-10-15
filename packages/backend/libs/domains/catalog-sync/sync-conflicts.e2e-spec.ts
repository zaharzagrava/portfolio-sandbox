import { v7 as uuidv7 } from 'uuid';
import { getConnectionToken } from '@nestjs/sequelize';
import { QueryTypes, type Sequelize } from 'sequelize';
import {
  syncConflictPageSchema,
  syncConflictSchema,
  syncEventSchemas,
  syncPushResponseSchema,
} from '@marketplace-sandbox/contracts';
import { ProductCommandService } from '@app/domains/catalog';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import {
  createCatalogApp,
  type CatalogTestApp,
  type TestUser,
} from '@app/test/utils/catalog-app';
import { TenancyFixture } from '@app/test/utils/s08-tenancy-fixture';
import {
  OfflineSyncModule,
  OfflineSyncProjectorModule,
  OfflineSyncWorkerModule,
} from './sync.module';
import { encodeHlc } from './domain/hlc';

describe('Offline sync: conflict review', () => {
  let ctx: CatalogTestApp;
  let db: Sequelize;
  let tenancy: TenancyFixture;
  let commands: ProductCommandService;
  let logical = 0;

  beforeAll(async () => {
    ctx = await createCatalogApp({
      extraImports: [
        OfflineSyncModule,
        OfflineSyncWorkerModule,
        OfflineSyncProjectorModule,
      ],
    });
    db = ctx.app.get(getConnectionToken());
    tenancy = new TenancyFixture(db);
    commands = ctx.app.get(ProductCommandService);
  });

  afterAll(async () => {
    await ctx.close();
  });

  // ---- helpers ------------------------------------------------------------------------------------------------

  async function world() {
    const owner = await ctx.newUser();
    const shop = await tenancy.createShop({ ownerId: owner.id });
    return { owner, shopId: shop.id };
  }
  type World = { owner: TestUser; shopId: string };

  /** A sale of a unit the shop does not have: the oversold conflict a device push leaves behind. */
  async function conflict(w: World, device = 'dev-a'): Promise<string> {
    const created = await commands.create(w.shopId, w.owner.id, {
      title: 'Mug',
      brand: 'Acme',
      category: 'home',
      priceMinor: 1_000,
      quantity: 0,
    });
    const opId = uuidv7();
    const res = await ctx
      .as(w.owner)
      .post(`/api/shops/${w.shopId}/sync/push`)
      .set('X-Device-Id', device)
      .send({
        ops: [
          {
            type: 'stock.adjust',
            opId,
            hlc: encodeHlc({
              physical: ctx.clock.now().getTime(),
              logical: ++logical,
              node: device,
            }),
            productId: created.id,
            delta: -2,
            reason: 'sold',
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(syncPushResponseSchema.parse(res.body).results[0].status).toBe(
      'conflict',
    );
    ctx.clock.advance(1_000); // so the list order by time is visible
    return opId;
  }

  const list = (w: World, query = '', user: TestUser = w.owner) =>
    ctx.as(user).get(`/api/shops/${w.shopId}/sync/conflicts${query}`);
  const dismiss = (w: World, opId: string, user: TestUser = w.owner) =>
    ctx.as(user).post(`/api/shops/${w.shopId}/sync/conflicts/${opId}/dismiss`);

  const conflictRow = async (shopId: string, opId: string) =>
    (
      await db.query<Record<string, any>>(
        `SELECT * FROM "SyncConflict" WHERE "shopId" = :shopId AND "opId" = :opId`,
        { type: QueryTypes.SELECT, replacements: { shopId, opId } },
      )
    )[0];
  const operationRow = async (shopId: string, opId: string) =>
    (
      await db.query<Record<string, any>>(
        `SELECT * FROM "SyncOperation" WHERE "shopId" = :shopId AND "opId" = :opId`,
        { type: QueryTypes.SELECT, replacements: { shopId, opId } },
      )
    )[0];

  // ---- tests --------------------------------------------------------------------------------------------------

  it('S09 AS-39: conflicts list newest first, page by page, filtered by status, and bad parameters are 400', async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await conflict(w, `dev-${i}a`));
    // the two oldest are settled
    for (const id of ids.slice(0, 2))
      expect((await dismiss(w, id)).status).toBe(200);

    const first = await list(w, '?limit=2');
    expect(first.status).toBe(200);
    const firstPage = syncConflictPageSchema.parse(first.body);
    expect(firstPage.items.map((i) => i.opId)).toEqual([ids[4], ids[3]]);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.items[0]).toEqual({
      opId: ids[4],
      deviceId: 'dev-4a',
      productId: expect.any(String),
      kind: 'oversold',
      requested: -2,
      applied: 0,
      shortfall: 2,
      quantityAfter: 0,
      status: 'open',
      createdAt: expect.any(String),
    });

    const second = syncConflictPageSchema.parse(
      (
        await list(
          w,
          `?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
        )
      ).body,
    );
    expect(second.items.map((i) => i.opId)).toEqual([ids[2]]);
    expect(second.nextCursor).toBeNull();

    const settled = syncConflictPageSchema.parse(
      (await list(w, '?status=dismissed')).body,
    );
    expect(settled.items.map((i) => i.opId)).toEqual([ids[1], ids[0]]);
    expect(
      settled.items.every(
        (i) =>
          i.status === 'dismissed' &&
          i.dismissedAt &&
          i.dismissedBy === w.owner.id,
      ),
    ).toBe(true);

    for (const bad of [
      '?status=all',
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?x=1',
    ])
      expect([bad, (await list(w, bad)).status]).toEqual([bad, 400]);
    const cursor = await list(w, '?cursor=garbage');
    expect([cursor.status, cursor.body.code]).toEqual([400, 'invalid_cursor']);
    // a cursor of the open list does not open the dismissed one
    const crossed = await list(
      w,
      `?status=dismissed&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
    );
    expect([crossed.status, crossed.body.code]).toEqual([
      400,
      'invalid_cursor',
    ]);
  });

  it('S09 AS-40: dismissing works once, a second and a simultaneous call get 409, the operation result stays', async () => {
    const w = await world();
    const opId = await conflict(w);
    const before = await operationRow(w.shopId, opId);

    const done = await dismiss(w, opId);
    expect(done.status).toBe(200);
    const body = syncConflictSchema.parse(done.body);
    expect(body).toMatchObject({
      opId,
      status: 'dismissed',
      dismissedBy: w.owner.id,
    });
    expect(body.dismissedAt).toEqual(expect.any(String));
    const again = await dismiss(w, opId);
    expect([again.status, again.body.code]).toEqual([409, 'conflict_not_open']);
    expect(await operationRow(w.shopId, opId)).toEqual(before);
    expect((await conflictRow(w.shopId, opId)).status).toBe('dismissed');

    const racing = await conflict(w);
    const [a, b] = await Promise.all([dismiss(w, racing), dismiss(w, racing)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409)?.body.code).toBe(
      'conflict_not_open',
    );
  });

  it("S09 AS-41: another shop's conflict is not found, a viewer may list but not dismiss", async () => {
    const a = await world();
    const b = await world();
    const mine = await conflict(a);
    const theirs = await conflict(b);
    const viewer = await ctx.newUser();
    await tenancy.addMember(a.shopId, viewer.id, 'VIEWER');

    const foreign = await dismiss(a, theirs);
    expect([foreign.status, foreign.body.code]).toEqual([404, 'not_found']);
    expect((await conflictRow(b.shopId, theirs)).status).toBe('open');
    const unknown = await dismiss(a, uuidv7());
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual({
      ...foreign.body,
      instance: unknown.body.instance,
      requestId: unknown.body.requestId,
    });

    const listed = await list(a, '', viewer);
    expect(listed.status).toBe(200);
    expect(
      syncConflictPageSchema.parse(listed.body).items.map((i) => i.opId),
    ).toEqual([mine]);
    const refused = await dismiss(a, mine, viewer);
    expect([refused.status, refused.body.code]).toEqual([
      403,
      'permission_denied',
    ]);
    expect((await conflictRow(a.shopId, mine)).status).toBe('open');
  });

  it('S09 AS-08: the conflict event on the outbox matches the contract and carries the numbers', async () => {
    const w = await world();
    const opId = await conflict(w, 'dev-z');

    const rows = (await outboxRowsFor(ctx.app, opId)).filter(
      (r) => r.type === 'catalogsync.offline_conflict_opened',
    );
    expect(rows).toHaveLength(1);
    const event = syncEventSchemas['catalogsync.offline_conflict_opened'].parse(
      rows[0].payload,
    );
    expect(event.payload).toEqual({
      opId,
      shopId: w.shopId,
      deviceId: 'dev-z',
      productId: expect.any(String),
      kind: 'oversold',
      requested: -2,
      applied: 0,
      shortfall: 2,
      quantityAfter: 0,
    });
    expect(rows[0].topic).toBe('catalogsync.events');
    expect(event.aggregateId).toBe(opId);
  });
});
