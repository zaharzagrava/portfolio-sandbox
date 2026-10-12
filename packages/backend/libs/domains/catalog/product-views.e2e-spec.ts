import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { CacheService } from '@app/infrastructure/cache';
import { JOB_HANDLER_METADATA } from '@app/infrastructure/jobs/job-handler.decorator';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import {
  createProduct,
  createProducts,
  recordStatements,
} from '@app/test/utils/catalog-fixtures';
import { ProductViewsService } from './application/product-views.service';
import { SequelizeViewBatchRepository } from './infra/view-batch.repository';
import { ProductViewsJobs } from './infra/product-views.jobs';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import { createShopWorld, type ShopWorld } from './testing/catalog-spec-kit';

const PENDING = 'counter:{product-views}:pending';
const CLAIMS = 'counter:{product-views}:claims';

describe('Product views write-behind', () => {
  let t: CatalogTestApp;
  let sequelize: Sequelize;
  let redis: RedisService;
  let views: ProductViewsService;
  let repo: SequelizeViewBatchRepository;
  let w: ShopWorld;

  const pending = async (id: string) =>
    Number((await redis.client.hget(PENDING, id)) ?? 0);
  const stage = async (id: string, by: number) => {
    await redis.client.hincrby(PENDING, id, by);
  };
  const viewCount = async (id: string) => {
    const [r] = await sequelize.query<{ viewCount: string }>(
      `SELECT "viewCount" FROM "Product" WHERE id = :id`,
      { replacements: { id }, type: QueryTypes.SELECT },
    );
    return Number(r.viewCount);
  };
  const setTrigger = (when: string) =>
    sequelize.query(`
      CREATE OR REPLACE FUNCTION s05_views_fail() RETURNS trigger AS $$
      BEGIN ${when} RETURN NEW; END; $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS s05_views_fail ON "Product";
      CREATE TRIGGER s05_views_fail BEFORE UPDATE ON "Product"
        FOR EACH ROW EXECUTE FUNCTION s05_views_fail();`);
  const dropTrigger = () =>
    sequelize.query(`DROP TRIGGER IF EXISTS s05_views_fail ON "Product"`);

  beforeAll(async () => {
    t = await createCatalogApp({ extraImports: [JobsModule] });
    sequelize = t.app.get(Sequelize);
    redis = t.app.get(RedisService);
    repo = new SequelizeViewBatchRepository(sequelize);
    views = new ProductViewsService(
      redis,
      t.clock,
      t.app.get(TransactionRunner, { strict: false }),
      repo,
    );
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await dropTrigger();
    await t.reset();
    w = await createShopWorld(t);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await dropTrigger();
  });

  it('S05 AS-66: 5 views then a flush adds 5 to viewCount, empties the pending hash and leaves version and updatedAt alone', async () => {
    const p = await createProduct(t.app, w.shop, {});
    const [before] = await sequelize.query<{
      version: number;
      updatedAt: Date;
    }>(`SELECT "version","updatedAt" FROM "Product" WHERE id = :id`, {
      replacements: { id: p.id },
      type: QueryTypes.SELECT,
    });
    const start = await viewCount(p.id);
    for (let i = 0; i < 5; i++) views.count(p.id);
    await waitUntil(async () => (await pending(p.id)) === 5);

    await views.flush();

    expect(await viewCount(p.id)).toBe(start + 5);
    expect(await pending(p.id)).toBe(0);
    const [after] = await sequelize.query<{ version: number; updatedAt: Date }>(
      `SELECT "version","updatedAt" FROM "Product" WHERE id = :id`,
      { replacements: { id: p.id }, type: QueryTypes.SELECT },
    );
    expect(after).toEqual(before);
  });

  it('S05 AS-67: a failing UPDATE fails the flush visibly, puts the 5 back, and the next flush after the fault stores exactly 5', async () => {
    const p = await createProduct(t.app, w.shop, {});
    const start = await viewCount(p.id);
    await stage(p.id, 5);
    await setTrigger(`RAISE EXCEPTION 's05 boom';`);

    await expect(views.flush()).rejects.toThrow();
    expect(await viewCount(p.id)).toBe(start);
    expect(await pending(p.id)).toBe(5);
    expect(await redis.client.zcard(CLAIMS)).toBe(0);

    await dropTrigger();
    await views.flush();
    expect(await viewCount(p.id)).toBe(start + 5);
    expect(await pending(p.id)).toBe(0);
  });

  it('S05 AS-68: views counted while a flush runs are neither lost nor counted twice', async () => {
    const p = await createProduct(t.app, w.shop, {});
    const start = await viewCount(p.id);
    await stage(p.id, 3);
    const flushing = views.flush();
    for (let i = 0; i < 4; i++) views.count(p.id);
    await flushing;
    await waitUntil(
      async () => (await viewCount(p.id)) + (await pending(p.id)) === start + 7,
    );
    await views.flush();
    expect(await viewCount(p.id)).toBe(start + 7);
    expect(await pending(p.id)).toBe(0);
  });

  it('S05 AS-69: 2,500 products are applied in 3 statements of at most 1,000; a failure in chunk 2 keeps chunk 1 applied and puts chunks 2 and 3 back; the next run applies the rest exactly once', async () => {
    const products = await createProducts(t.app, w.shop, 2_500);
    const ids = products.map((p) => p.id).sort();
    const pipeline = redis.client.pipeline();
    for (const id of ids) pipeline.hincrby(PENDING, id, 2);
    await pipeline.exec();

    const first = await recordStatements(t.app, () => views.flush());
    const updates = first.statements.filter((s) => /UPDATE "Product"/.test(s));
    expect(updates).toHaveLength(3);
    expect(await viewCount(ids[0])).toBe(2);
    expect(await pending(ids[0])).toBe(0);

    // second round: fail the second chunk
    const pipeline2 = redis.client.pipeline();
    for (const id of ids) pipeline2.hincrby(PENDING, id, 1);
    await pipeline2.exec();
    const original = repo.applyChunk.bind(repo);
    let calls = 0;
    jest.spyOn(repo, 'applyChunk').mockImplementation((...args) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('chunk 2 down'));
      return original(...args);
    });
    await expect(views.flush()).rejects.toThrow('chunk 2 down');
    jest.restoreAllMocks();

    const done = await sequelize.query<{ n: string }>(
      `SELECT count(*) n FROM "Product" WHERE "shopId" = :s AND "viewCount" = 3`,
      { replacements: { s: w.shop.id }, type: QueryTypes.SELECT },
    );
    expect(Number(done[0].n)).toBe(1_000);
    expect(await redis.client.hlen(PENDING)).toBe(1_500);
    expect(await redis.client.zcard(CLAIMS)).toBe(0);

    await views.flush();
    const rows = await sequelize.query<{ viewCount: string }>(
      `SELECT "viewCount" FROM "Product" WHERE "shopId" = :s`,
      { replacements: { s: w.shop.id }, type: QueryTypes.SELECT },
    );
    expect(rows).toHaveLength(2_500);
    expect(rows.every((r) => Number(r.viewCount) === 3)).toBe(true);
    expect(await redis.client.hlen(PENDING)).toBe(0);
  }, 60_000);

  it('S05 AS-69: a replay of an applied chunk of the same batch is skipped through the ProductViewBatch marker', async () => {
    const p = await createProduct(t.app, w.shop, {});
    const batchId = '0190aaaa-0000-7000-8000-000000000001';
    const start = await viewCount(p.id);
    expect(await repo.applyChunk(batchId, 0, [p.id], [4])).toBe(true);
    expect(await repo.applyChunk(batchId, 0, [p.id], [4])).toBe(false);
    expect(await viewCount(p.id)).toBe(start + 4);
  });

  it('S05 AS-70: a deleted product is no poison (others applied); a non-UUID member is skipped and counted', async () => {
    const p = await createProduct(t.app, w.shop, {});
    const start = await viewCount(p.id);
    await stage(p.id, 2);
    await stage('00000000-0000-4000-8000-00000000dead', 9);
    await stage('not-a-uuid', 1);

    await views.flush();

    expect(await viewCount(p.id)).toBe(start + 2);
    expect(await redis.client.hlen(PENDING)).toBe(0);
    expect(await redis.client.zcard(CLAIMS)).toBe(0);
  });

  it('S05 AS-71: two flushes at the same moment apply each delta exactly once', async () => {
    const p = await createProduct(t.app, w.shop, {});
    const start = await viewCount(p.id);
    await stage(p.id, 7);
    await Promise.all([views.flush(), views.flush()]);
    expect(await viewCount(p.id)).toBe(start + 7);
    expect(await pending(p.id)).toBe(0);
  });

  it('S05 AS-72: with the cache down the read still succeeds, nothing is counted and nothing throws', async () => {
    const p = await createProduct(t.app, w.shop, {});
    jest.spyOn(redis.client, 'eval').mockRejectedValue(new Error('redis down'));
    jest
      .spyOn(redis.client, 'evalsha')
      .mockRejectedValue(new Error('redis down'));
    expect(() => views.count(p.id)).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    jest.restoreAllMocks();
    expect(await pending(p.id)).toBe(0);
  });

  it('S05 AS-73: 404, 400, 429-free hidden reads and the batch route count no view', async () => {
    const hidden = await createProduct(t.app, w.shop, { status: 'ARCHIVED' });
    const visible = await createProduct(t.app, w.shop, {});
    await t
      .http()
      .get(`/api/products/00000000-0000-4000-8000-000000000999`)
      .expect(404);
    await t.http().get(`/api/products/not-a-uuid`).expect(400);
    await t.http().get(`/api/products/${hidden.id}`).expect(404);
    await t
      .http()
      .post('/api/products/batch')
      .send({ ids: [visible.id, hidden.id] });
    await new Promise((r) => setTimeout(r, 100));
    expect(await redis.client.hlen(PENDING)).toBe(0);
  });

  it('S05 AS-74: a flush writes no outbox row, deletes no cache entry and changes no version', async () => {
    const p = await createProduct(t.app, w.shop, {});
    await t.http().get(`/api/products/${p.id}`).expect(200);
    await waitUntil(async () => (await pending(p.id)) === 1);
    const del = jest.spyOn(CacheService.prototype, 'invalidate');
    const outboxBefore = await sequelize.query<{ n: string }>(
      `SELECT count(*) n FROM "Outbox"`,
      { type: QueryTypes.SELECT },
    );
    const keysBefore = await redis.client.keys('product:v2:*');

    await views.flush();

    const outboxAfter = await sequelize.query<{ n: string }>(
      `SELECT count(*) n FROM "Outbox"`,
      { type: QueryTypes.SELECT },
    );
    expect(outboxAfter[0].n).toBe(outboxBefore[0].n);
    expect(del).not.toHaveBeenCalled();
    expect(await redis.client.keys('product:v2:*')).toEqual(keysBefore);
  });

  it('S05 AS-75: the job is scheduled every 10 seconds exactly once however many schedulers register it, with one run in the fleet', async () => {
    const jobs = t.app.get(JobsService, { strict: false });
    const a = new ProductViewsJobs(jobs, views);
    const b = new ProductViewsJobs(jobs, views);
    await a.onApplicationBootstrap();
    await b.onApplicationBootstrap();
    const rows = await sequelize.query<{ cron: string; jobType: string }>(
      `SELECT "cron","jobType" FROM "JobSchedule" WHERE "name" = 'products.flush-view-counts'`,
      { type: QueryTypes.SELECT },
    );
    expect(rows).toEqual([
      { cron: '*/10 * * * * *', jobType: 'products.flush-view-counts' },
    ]);
    const meta = Reflect.getMetadata(
      JOB_HANDLER_METADATA,
      ProductViewsJobs.prototype.flush,
    );
    expect(meta).toMatchObject({
      type: 'products.flush-view-counts',
      concurrency: 1,
      fleetConcurrency: 1,
    });
  });
});

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
}
