import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  reindexRunSchema,
  searchIndexStatusSchema,
} from '@marketplace-sandbox/contracts';
import { MAPPING_VERSION } from './domain/index-definition';
import { Gate } from './testing/reindex-probe';
import { createSearchApp, type SearchTestApp } from './testing/search-app';
import { deliver, newId, productEvent, snapshot } from './testing/search-events';
import { createShop } from '@app/test/utils/tenancy-fixtures';

describe('Search administration access and status', () => {
  let t: SearchTestApp;
  let adminUser: Awaited<ReturnType<SearchTestApp['admin']>>;

  beforeAll(async () => {
    t = await createSearchApp({ redisProxy: true });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.resetSearch();
    await t.resetHistory();
    adminUser = await t.admin();
  });
  afterEach(() => jest.restoreAllMocks());

  const routes: [string, string][] = [
    ['get', '/api/admin/search/index'],
    ['post', '/api/admin/search/reindex'],
    ['get', '/api/admin/search/reindex'],
    ['get', `/api/admin/search/reindex/${randomUUID()}`],
    ['post', `/api/admin/search/reindex/${randomUUID()}/cancel`],
    ['post', '/api/admin/search/rollback'],
  ];
  const call = (user: { bearer: string } | null, [method, url]: [string, string]) => {
    const req = (t.http() as unknown as Record<string, (u: string) => import('supertest').Test>)[method](url);
    return user ? req.set('Authorization', user.bearer) : req;
  };

  it('S32 AS-52: every admin route answers 401 without credentials and 403 to a shop owner and to an ordinary user', async () => {
    const owner = await t.newUser();
    await createShop(t.app, owner);
    const user = await t.newUser();
    for (const route of routes) {
      expect((await call(null, route)).status).toBe(401);
      expect((await call(owner, route)).status).toBe(403);
      expect((await call(user, route)).status).toBe(403);
    }
  });

  it('S32 AS-52: an administrator action leaves an audit line with the actor, the action and the run id, and no secret', async () => {
    const lines: unknown[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      lines.push(message);
    });
    const res = await t.as(adminUser).post('/api/admin/search/reindex').expect(202);
    const audit = lines.find(
      (l) => typeof l === 'object' && l !== null && (l as { action?: string }).action === 'search.reindex.start',
    );
    expect(audit).toMatchObject({ actorId: adminUser.id, runId: res.body.runId });
    expect(JSON.stringify(audit)).not.toMatch(/secret|token|password|bearer/i);
  });

  it('S32 AS-52: one administrator past 30 calls a minute gets 429 with Retry-After; with the limiter store down the routes fail closed with 503', async () => {
    let limited: { status: number; headers: Record<string, string> } | undefined;
    for (let i = 0; i < 33 && !limited; i++) {
      const res = await t.as(adminUser).get('/api/admin/search/index');
      if (res.status === 429) limited = res;
    }
    expect(limited?.status).toBe(429);
    expect(limited?.headers['retry-after']).toBeDefined();

    const other = await t.admin();
    t.redisProxy!.mode = 'refuse';
    t.redisProxy!.sever();
    const closed = await t.as(other).get('/api/admin/search/index');
    expect(closed.status).toBe(503);
  });

  it('S32 AS-77: the index status reports the alias, the active and previous index, versions, counts and the runs around a reindex', async () => {
    const shopId = newId();
    const events = Array.from({ length: 6 }, (_, i) =>
      productEvent('created', snapshot({ productId: newId(), shopId, title: `Status ${i}` }), t.clock.now()),
    );
    await t.publishHistory(events);
    await deliver(t.app).products(...events);
    await t.refresh();
    const status = async () =>
      searchIndexStatusSchema.parse((await t.as(adminUser).get('/api/admin/search/index').expect(200)).body);

    const before = await status();
    expect(before).toMatchObject({
      alias: 'products',
      previousIndex: null,
      previousRetiresAt: null,
      mappingVersion: MAPPING_VERSION,
      expectedMappingVersion: MAPPING_VERSION,
      outdated: false,
      documentCount: 6,
      embeddingPendingCount: 0,
      synonymsVersion: 1,
      activeRun: null,
      lastRun: null,
    });
    expect(before.projectionLagSeconds).toBeGreaterThanOrEqual(0);
    const oldIndex = before.activeIndex;

    const gate = new Gate();
    t.probe.hooks.afterBuildingStarted = async () => {
      await gate.wait();
    };
    const accepted = await t.as(adminUser).post('/api/admin/search/reindex').expect(202);
    const running = t.worker.runOnce();
    await gate.reached;
    expect((await status()).activeRun).toEqual({ runId: accepted.body.runId, status: 'BUILDING' });
    gate.release();
    await running;

    const after = await status();
    expect(after.activeRun).toBeNull();
    expect(after.previousIndex).toBe(oldIndex);
    expect(after.previousRetiresAt).not.toBeNull();
    expect(after.activeIndex).not.toBe(oldIndex);
    expect(after.lastRun).toMatchObject({ runId: accepted.body.runId, kind: 'REINDEX', status: 'COMPLETED' });
    expect(after.lastRun!.finishedAt).not.toBeNull();
  });

  it('S32 AS-39: the run list is keyset paged newest first and refuses a cursor that is not its own', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await t.as(adminUser).post('/api/admin/search/reindex').expect(202);
      ids.push(res.body.runId);
      await t.as(adminUser).post(`/api/admin/search/reindex/${res.body.runId}/cancel`).expect(200);
      t.clock.advance(1_000);
    }
    const page1 = await t.as(adminUser).get('/api/admin/search/reindex?limit=2').expect(200);
    expect(page1.body.items.map((r: { runId: string }) => r.runId)).toEqual([ids[2], ids[1]]);
    page1.body.items.forEach((r: unknown) => reindexRunSchema.parse(r));
    const page2 = await t.as(adminUser).get(`/api/admin/search/reindex?limit=2&cursor=${page1.body.nextCursor}`).expect(200);
    expect(page2.body.items.map((r: { runId: string }) => r.runId)).toEqual([ids[0]]);
    expect(page2.body.nextCursor).toBeNull();
    const bad = await t.as(adminUser).get('/api/admin/search/reindex?cursor=garbage').expect(422);
    expect(bad.body.code).toBe('invalid_cursor');
    await t.as(adminUser).get('/api/admin/search/reindex?limit=0').expect(400);
  });
});
