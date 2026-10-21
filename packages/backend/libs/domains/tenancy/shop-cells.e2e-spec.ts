import { shardId } from '@app/common/shard';
import { Logger } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { shopDirectorySchema } from '@marketplace-sandbox/contracts';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { Role, SessionRevocationService } from '@app/domains/identity';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { DIRECTORY_REPOSITORY } from './domain/ports';
import {
  ShopCellService,
  CELL_CACHE_TTL_MS,
} from './application/shop-cell.service';
import { TenantConnectionResolver } from './infra/tenant-connection.resolver';
import { createTenancyApp, type TenancyTestApp } from './testing/tenancy-app';

// one cell database per test shard (TEST_SHARD): `...dedicated1_s<n>`; unchanged without a shard
const CELL_DB = `marketplace_test_cell_dedicated1${shardId() === '' ? '' : `_s${shardId()}`}`;
const env = (name: string) => process.env[name] ?? '';

/** The second database the cell lives in: same server as the test database, own database and role limits. */
async function ensureCellDatabase(): Promise<string> {
  const base = `postgres://${env('DB_USERNAME')}:${env('DB_PASSWORD')}@${env('DB_HOST')}:${env('DB_PORT')}`;
  const admin = new Sequelize(`${base}/${env('DB_NAME')}`, {
    dialect: 'postgres',
    logging: false,
  });
  try {
    const found = await admin.query(
      `SELECT 1 FROM pg_database WHERE datname = '${CELL_DB}'`,
      { type: QueryTypes.SELECT },
    );
    if (found.length === 0) await admin.query(`CREATE DATABASE ${CELL_DB}`);
  } finally {
    await admin.close();
  }
  return `${base}/${CELL_DB}`;
}

describe('Database cells', () => {
  let t: TenancyTestApp;
  let sequelize: Sequelize;
  let resolver: TenantConnectionResolver;
  let cells: ShopCellService;
  const saved: Record<string, string | undefined> = {};

  const moveUrl = (shopId: string) => `/api/admin/shops/${shopId}/directory`;
  const directoryRow = async (shopId: string) =>
    (
      await sequelize.query<{ cell: string; region: string; version: string }>(
        `SELECT "cell","region","version" FROM "ShopDirectory" WHERE "shopId" = $1`,
        { bind: [shopId], type: QueryTypes.SELECT },
      )
    )[0];
  const admin = () => t.newUser({ role: Role.ADMIN });

  beforeAll(async () => {
    const cellUrl = await ensureCellDatabase();
    for (const [name, value] of Object.entries({
      TENANCY_CELLS: JSON.stringify({
        'dedicated-1': cellUrl,
        'broken-1': 'postgres://nobody:nothing@127.0.0.1:1/none',
      }),
      TENANCY_CELL_POOL_MAX: '1',
    })) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    t = await createTenancyApp();
    sequelize = t.app.get(Sequelize);
    resolver = t.app.get(TenantConnectionResolver);
    cells = t.app.get(ShopCellService);
  });
  afterAll(async () => {
    await t.close();
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  beforeEach(() => t.reset());
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('S03 AS-51: a new shop is in the pooled cell, version 1, in the default or the requested allowed region', async () => {
    const owner = await t.newUser();
    const first = await t
      .as(owner)
      .post('/api/shops')
      .send({ name: 'Cell One', slug: 'cell-one' })
      .expect(201);
    expect(await directoryRow(first.body.id)).toEqual({
      cell: 'pooled',
      region: 'eu-central-1',
      version: '1',
    });
    expect(await cells.cellOf(first.body.id)).toEqual({
      cell: 'pooled',
      region: 'eu-central-1',
    });
    const second = await t
      .as(owner)
      .post('/api/shops')
      .send({ name: 'Cell Two', slug: 'cell-two', region: 'us-east-1' })
      .expect(201);
    expect((await directoryRow(second.body.id)).region).toBe('us-east-1');
    expect((await cells.cellOf(second.body.id)).region).toBe('us-east-1');
  });

  describe('S03 AS-52: moving a shop between cells', () => {
    it('the platform administrator moves it; version, event, audit line and the cached cell follow', async () => {
      const owner = await t.newUser();
      const root = await admin();
      const shop = await createShop(t.app, owner);
      const lines: Array<Record<string, unknown>> = [];
      jest.spyOn(Logger.prototype, 'log').mockImplementation((...args) => {
        const first = args[0];
        if (first && typeof first === 'object' && 'action' in first)
          lines.push(first as Record<string, unknown>);
      });
      expect((await cells.cellOf(shop.id)).cell).toBe('pooled'); // cached

      const res = await t
        .as(root)
        .put(moveUrl(shop.id))
        .send({
          cell: 'dedicated-1',
          region: 'us-east-1',
          expectedVersion: 1,
          reason: 'contract: dedicated database',
        })
        .expect(200);
      expect(shopDirectorySchema.parse(res.body)).toEqual({
        shopId: shop.id,
        cell: 'dedicated-1',
        region: 'us-east-1',
        version: 2,
      });
      expect(await directoryRow(shop.id)).toEqual({
        cell: 'dedicated-1',
        region: 'us-east-1',
        version: '2',
      });
      const moved = (await outboxRowsFor(t.app, shop.id)).filter(
        (e) => e.type === 'tenancy.shop_cell_moved',
      );
      expect(moved).toHaveLength(1);
      expect((moved[0].payload as { payload: unknown }).payload).toEqual({
        shopId: shop.id,
        fromCell: 'pooled',
        toCell: 'dedicated-1',
        region: 'us-east-1',
        version: 2,
      });
      expect(lines).toContainEqual(
        expect.objectContaining({
          action: 'shop.cell_moved',
          actorId: root.id,
          shopId: shop.id,
          reason: 'contract: dedicated database',
        }),
      );
      expect(await cells.cellOf(shop.id)).toEqual({
        cell: 'dedicated-1',
        region: 'us-east-1',
      });
      const read = await t.as(root).get(moveUrl(shop.id)).expect(200);
      expect(shopDirectorySchema.parse(read.body).version).toBe(2);
    });

    it('is refused to a non-administrator and to a revoked administrator session; nothing changes', async () => {
      const owner = await t.newUser();
      const root = await admin();
      const shop = await createShop(t.app, owner);
      const body = {
        cell: 'dedicated-1',
        region: 'eu-central-1',
        expectedVersion: 1,
        reason: 'x',
      };
      await t.as(owner).put(moveUrl(shop.id)).send(body).expect(403);
      await t.as(owner).get(moveUrl(shop.id)).expect(403);
      await t.app
        .get(SessionRevocationService)
        .revokeBySid(root.sessionId, 'logout');
      await t.as(root).put(moveUrl(shop.id)).send(body).expect(401);
      expect((await directoryRow(shop.id)).version).toBe('1');
      expect(
        (await outboxRowsFor(t.app, shop.id)).filter(
          (e) => e.type === 'tenancy.shop_cell_moved',
        ),
      ).toHaveLength(0);
    });

    it('answers unknown_cell, region_not_allowed, stale_version and validation errors without changing the row', async () => {
      const owner = await t.newUser();
      const root = await admin();
      const shop = await createShop(t.app, owner);
      const good = {
        cell: 'dedicated-1',
        region: 'eu-central-1',
        expectedVersion: 1,
        reason: 'x',
      };
      const put = (over: Record<string, unknown>) =>
        t
          .as(root)
          .put(moveUrl(shop.id))
          .send({ ...good, ...over });

      expect((await put({ cell: 'nowhere' }).expect(422)).body.code).toBe(
        'unknown_cell',
      );
      expect((await put({ region: 'mars-1' }).expect(422)).body.code).toBe(
        'region_not_allowed',
      );
      expect((await put({ expectedVersion: 7 }).expect(409)).body.code).toBe(
        'stale_version',
      );
      await put({ reason: '' }).expect(400);
      await put({ expectedVersion: 0 }).expect(400);
      await put({ extra: true }).expect(400);
      await t
        .as(root)
        .put(moveUrl('00000000-0000-4000-8000-000000000000'))
        .send(good)
        .expect(404);
      expect((await directoryRow(shop.id)).version).toBe('1');
    });

    it('two simultaneous moves with the same expectedVersion: one 200 and one 409', async () => {
      const owner = await t.newUser();
      const root = await admin();
      const shop = await createShop(t.app, owner);
      const body = (cell: string) => ({
        cell,
        region: 'eu-central-1',
        expectedVersion: 1,
        reason: 'race',
      });
      const results = await Promise.all([
        t.as(root).put(moveUrl(shop.id)).send(body('dedicated-1')),
        t.as(root).put(moveUrl(shop.id)).send(body('pooled')),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await directoryRow(shop.id)).version).toBe('2');
      expect(
        (await outboxRowsFor(t.app, shop.id)).filter(
          (e) => e.type === 'tenancy.shop_cell_moved',
        ),
      ).toHaveLength(1);
    });
  });

  describe('S03 AS-53: routing', () => {
    it('a pooled shop gets the pooled connection and a dedicated shop gets the cell pool, whose statements are time-bounded', async () => {
      const owner = await t.newUser();
      const pooledShop = await createShop(t.app, owner);
      const dedicated = await createShop(t.app, owner, { cell: 'dedicated-1' });

      expect(await resolver.connectionFor(pooledShop.id)).toBe(
        t.app.get(Sequelize),
      );
      const cell = await resolver.connectionFor(dedicated.id);
      expect(cell).not.toBe(t.app.get(Sequelize));
      const [row] = await cell.query<{ db: string; timeout: string }>(
        `SELECT current_database() AS db, current_setting('statement_timeout') AS timeout`,
        { type: QueryTypes.SELECT },
      );
      expect(row.db).toBe(CELL_DB);
      expect(row.timeout).not.toMatch(/^0(ms|s)?$/);

      const viaHttp = await t
        .as(owner)
        .get(`/api/probe/cell/${dedicated.id}`)
        .expect(200);
      expect(viaHttp.body).toEqual({ database: CELL_DB });
    });

    it('a cell the process has no connection for, or cannot reach, is 503 cell_unavailable and never the pooled database', async () => {
      const owner = await t.newUser();
      const ghost = await createShop(t.app, owner, { cell: 'ghost-9' });
      const broken = await createShop(t.app, owner, { cell: 'broken-1' });
      for (const shop of [ghost, broken]) {
        await expect(resolver.connectionFor(shop.id)).rejects.toMatchObject({
          code: 'cell_unavailable',
          status: 503,
        });
        const res = await t
          .as(owner)
          .get(`/api/probe/cell/${shop.id}`)
          .expect(503);
        expect(res.body.code).toBe('cell_unavailable');
        expect(res.headers['retry-after']).toBeDefined();
        expect(JSON.stringify(res.body)).not.toContain('nobody:nothing');
      }
    });
  });

  it('S03 AS-54: with the dedicated pool fully held, its shop answers 503 after the acquire timeout while pooled shops stay 200', async () => {
    const owner = await t.newUser();
    const dedicated = await createShop(t.app, owner, { cell: 'dedicated-1' });
    const pooledShops = await Promise.all(
      [1, 2, 3].map(() => createShop(t.app, owner)),
    );
    await t.as(owner).get(`/api/probe/cell/${dedicated.id}`).expect(200);
    const pool = resolver.openPools().get('dedicated-1')!;
    const held = await pool.connectionManager.getConnection({ type: 'read' });
    try {
      const started = Date.now();
      const [slow, ...fast] = await Promise.all([
        t.as(owner).get(`/api/probe/cell/${dedicated.id}`),
        ...pooledShops.map(async (s) => {
          const at = Date.now();
          const res = await t.as(owner).get(`/api/probe/cell/${s.id}`);
          return Object.assign(res, { took: Date.now() - at });
        }),
      ]);
      expect(slow.status).toBe(503);
      expect(slow.body.code).toBe('cell_unavailable');
      expect(slow.headers['retry-after']).toBeDefined();
      expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      for (const res of fast) {
        expect(res.status).toBe(200);
        expect((res as unknown as { took: number }).took).toBeLessThan(1500);
      }
    } finally {
      pool.connectionManager.releaseConnection(held);
    }
    await t.as(owner).get(`/api/probe/cell/${dedicated.id}`).expect(200);
  });

  describe('S03 AS-55: the cell cache', () => {
    it('answers a repeat without a query, is dropped by a move, and a lost invalidation lasts at most five minutes', async () => {
      const owner = await t.newUser();
      const root = await admin();
      const shop = await createShop(t.app, owner);
      const find = jest.spyOn(t.app.get(DIRECTORY_REPOSITORY), 'find');

      await cells.cellOf(shop.id);
      await cells.cellOf(shop.id);
      expect(find).toHaveBeenCalledTimes(1);

      await t
        .as(root)
        .put(moveUrl(shop.id))
        .send({
          cell: 'dedicated-1',
          region: 'eu-central-1',
          expectedVersion: 1,
          reason: 'move',
        })
        .expect(200);
      find.mockClear();
      expect((await cells.cellOf(shop.id)).cell).toBe('dedicated-1');
      expect(find).toHaveBeenCalledTimes(1); // re-read after the move

      // Lost invalidation: another instance moved the shop; this process still holds the old answer…
      await sequelize.query(
        `UPDATE "ShopDirectory" SET "cell" = 'pooled', "version" = "version" + 1 WHERE "shopId" = $1`,
        { bind: [shop.id] },
      );
      find.mockClear();
      t.clock.set(new Date(t.clock.now().getTime() + CELL_CACHE_TTL_MS - 1000));
      expect((await cells.cellOf(shop.id)).cell).toBe('dedicated-1');
      expect(find).not.toHaveBeenCalled();
      // …and it catches up when the entry expires.
      t.clock.set(new Date(t.clock.now().getTime() + 2000));
      expect((await cells.cellOf(shop.id)).cell).toBe('pooled');
      expect(find).toHaveBeenCalledTimes(1);
    });
  });

  it('S03 AS-56: the region is in the shop body and changes only through the administrator move', async () => {
    const owner = await t.newUser();
    const root = await admin();
    const created = await t
      .as(owner)
      .post('/api/shops')
      .send({ name: 'Regional', slug: 'regional-shop', region: 'us-east-1' })
      .expect(201);
    const shopId = created.body.id as string;
    expect(created.body.region).toBe('us-east-1');
    await t
      .as(owner)
      .patch(`/api/shops/${shopId}`)
      .send({ name: 'Regional 2', region: 'eu-central-1' })
      .expect(400);
    expect((await t.as(owner).get(`/api/shops/${shopId}`)).body.region).toBe(
      'us-east-1',
    );

    await t
      .as(root)
      .put(moveUrl(shopId))
      .send({
        cell: 'pooled',
        region: 'eu-central-1',
        expectedVersion: 1,
        reason: 'residency',
      })
      .expect(200);
    expect((await t.as(owner).get(`/api/shops/${shopId}`)).body.region).toBe(
      'eu-central-1',
    );
  });
});
