import { randomUUID } from 'node:crypto';
import {
  reindexAcceptedSchema,
  reindexRunSchema,
  searchIndexStatusSchema,
  productSearchResponseSchema,
  type ReindexRun,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { outboxRowsFor } from '@app/common/testing/outbox-rows';
import { waitFor } from '@app/test/utils/async-helpers';
import { MAPPING_VERSION, productsIndexDefinition, TEST_PROFILE } from './domain/index-definition';
import { SimulatedCrash } from './domain/ports';
import { IndexBootstrapService } from './infra/index-bootstrap.service';
import { SearchIndexRegistry } from './infra/search-index-registry';
import { SearchSettings } from './infra/search-settings';
import { RunExecutorService } from './application/reindex/run-executor.service';
import { RetirePreviousIndexJob } from './application/jobs/retire-previous-index.job';
import { Gate } from './testing/reindex-probe';
import { createSearchApp, type SearchTestApp } from './testing/search-app';
import {
  deliver,
  newId,
  productDeleted,
  productEvent,
  shopStatusEvent,
  snapshot,
} from './testing/search-events';

const HOUR = 3_600_000;
const failed = (reason: string) =>
  MetricsRegistry.value('search_reindex_failed_total', { reason }) ?? 0;

describe('Zero-downtime search reindex', () => {
  let t: SearchTestApp;
  let adminUser: Awaited<ReturnType<SearchTestApp['admin']>>;
  let shopId: string;
  const gates: Gate[] = [];
  /** A latch that is opened after the test whatever happens, so no run is left waiting in the worker. */
  const gate = () => {
    const g = new Gate();
    gates.push(g);
    return g;
  };

  beforeAll(async () => {
    t = await createSearchApp({ engineProxy: true });
  });
  afterAll(() => t.close());
  afterEach(() => {
    for (const g of gates.splice(0)) g.release();
  });
  beforeEach(async () => {
    await t.resetSearch();
    await t.resetHistory();
    adminUser = await t.admin();
    shopId = newId();
  });

  const post = (url: string) => t.as(adminUser).post(url);
  const get = (url: string) => t.as(adminUser).get(url);
  const startRun = async () => {
    const res = await post('/api/admin/search/reindex').expect(202);
    return reindexAcceptedSchema.parse(res.body);
  };
  const run = async (runId: string): Promise<ReindexRun> =>
    reindexRunSchema.parse((await get(`/api/admin/search/reindex/${runId}`).expect(200)).body);
  const runOnce = () => t.worker.runOnce();
  const live = async () => (await t.engine.aliasTargets('products'))[0];
  const history = (runId: string) =>
    t.rows<{ fromStatus: string | null; toStatus: string }>(
      `SELECT "fromStatus", "toStatus" FROM "SearchReindexRunHistory" WHERE "runId" = $1 ORDER BY "historyId"`,
      [runId],
    );

  /** The same products reach the live index (through the projector) and the retained history (the log). */
  const seed = async (
    count: number,
    over: (i: number) => Record<string, unknown> = () => ({}),
  ) => {
    const events = Array.from({ length: count }, (_, i) =>
      productEvent(
        'created',
        snapshot({
          productId: newId(),
          shopId,
          title: `Gadget ${i}`,
          productVersion: 1,
          priceMinor: 100 + i,
          ...over(i),
        }),
        t.clock.now(),
      ),
    );
    await t.publishHistory(events);
    for (let i = 0; i < events.length; i += 200)
      await deliver(t.app).products(...events.slice(i, i + 200));
    await t.refresh();
    return events.map((e) => e.aggregateId);
  };
  const versions = async (index = 'products') => {
    await t.es.indices.refresh({ index });
    const res = await t.es.search({
      index,
      size: 5_000,
      _source: ['productVersion', 'status', 'deleted', 'shopHidden', 'title'],
      query: { term: { hasProduct: true } },
      sort: ['productId'],
    });
    return Object.fromEntries(
      res.hits.hits.map((h) => [h._id, h._source as Record<string, unknown>]),
    );
  };

  describe('a run and its states (AS-39 to AS-41)', () => {
    it('S32 AS-39: a run builds the same documents beside the live index, switches once, keeps the previous index and reports itself', async () => {
      const ids = await seed(1_000);
      const before = await live();
      const beforeVersions = await versions();

      const accepted = await startRun();
      expect(accepted).toMatchObject({ kind: 'REINDEX', status: 'QUEUED' });
      await runOnce();

      const done = await run(accepted.runId);
      expect(done).toMatchObject({
        status: 'COMPLETED',
        kind: 'REINDEX',
        documents: 1_000,
        mappingVersion: MAPPING_VERSION,
        previousIndex: before,
        failureReason: null,
      });
      expect(done.index).not.toBe(before);
      expect(done.startedAt).not.toBeNull();
      expect(done.finishedAt).not.toBeNull();
      expect(await live()).toBe(done.index);
      expect(await versions()).toEqual(beforeVersions);
      expect(Object.keys(await versions())).toHaveLength(ids.length);
      expect(await t.es.indices.exists({ index: before })).toBe(true);
      expect(await history(accepted.runId)).toEqual([
        { fromStatus: null, toStatus: 'QUEUED' },
        { fromStatus: 'QUEUED', toStatus: 'BUILDING' },
        { fromStatus: 'BUILDING', toStatus: 'CATCHING_UP' },
        { fromStatus: 'CATCHING_UP', toStatus: 'COMPLETED' },
      ]);
      const event = (await outboxRowsFor(t.app, accepted.runId)).find(
        (r) => r.type === 'search.reindex_completed',
      );
      expect(event?.payload).toMatchObject({
        payload: { runId: accepted.runId, kind: 'REINDEX', index: done.index, previousIndex: before, documents: 1_000 },
      });
      const list = await get('/api/admin/search/reindex').expect(200);
      expect(list.body.items[0].runId).toBe(accepted.runId);
    });

    it('S32 AS-40: searches during a run all answer 200, the total never drops, and there is no moment without a live index', async () => {
      await seed(300);
      const accepted = await startRun();
      const running = runOnce();
      const statuses: number[] = [];
      const totals: number[] = [];
      let finished = false;
      void running.finally(() => {
        finished = true;
      });
      while (!finished) {
        const res = await t.http().get('/api/products/search').query({ q: 'gadget', limit: 1 });
        statuses.push(res.status);
        if (res.status === 200) totals.push(productSearchResponseSchema.parse(res.body).total.value);
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(statuses.length).toBeGreaterThan(5);
      expect(statuses.every((s) => s === 200)).toBe(true);
      expect(Math.min(...totals)).toBe(300);
      expect((await run(accepted.runId)).status).toBe('COMPLETED');
    });

    it('S32 AS-41: products created, updated, archived and deleted and a shop suspended during the build end up in the new index exactly as in the old one', async () => {
      const [keep, update, archive, remove] = await seed(4);
      const other = newId();
      const [suspended] = await (async () => {
        const e = productEvent('created', snapshot({ productId: newId(), shopId: other, title: 'Other shop' }), t.clock.now());
        await t.publishHistory([e]);
        await deliver(t.app).products(e);
        return [e.aggregateId];
      })();

      const building = gate();
      t.probe.hooks.afterBuildingStarted = async () => {
        await building.wait();
      };
      const accepted = await startRun();
      const running = runOnce();
      await building.reached;
      t.app.get(SearchIndexRegistry, { strict: false }).invalidate();

      const fresh = newId();
      await deliver(t.app).products(
        productEvent('created', snapshot({ productId: fresh, shopId, title: 'Created during the build' }), t.clock.now()),
        productEvent('updated', snapshot({ productId: update, shopId, title: 'Gadget 1 renamed', productVersion: 3 }), t.clock.now()),
        productEvent('archived', snapshot({ productId: archive, shopId, title: 'Gadget 2', status: 'ARCHIVED', productVersion: 2 }), t.clock.now()),
        productDeleted(remove, shopId, 2, t.clock.now()),
      );
      await deliver(t.app).shops(shopStatusEvent(other, 'SUSPENDED', 2, t.clock.now()));
      building.release();
      await running;

      const done = await run(accepted.runId);
      expect(done.status).toBe('COMPLETED');
      const fresher = await versions();
      const older = await versions(done.previousIndex!);
      expect(fresher).toEqual(older);
      expect(fresher[fresh]).toBeDefined();
      expect(fresher[update]).toMatchObject({ productVersion: 3, title: 'Gadget 1 renamed' });
      expect(fresher[archive]).toMatchObject({ status: 'ARCHIVED' });
      expect((await t.doc(remove))).toMatchObject({ deleted: true });
      expect((await t.doc(suspended))).toMatchObject({ shopHidden: true });
      expect(fresher[keep]).toMatchObject({ productVersion: 1 });
    });
  });

  describe('one active run, cancel, failure (AS-42 to AS-44)', () => {
    it('S32 AS-42: a second run or a rollback is refused with the active run id in every active status; two racing triggers give one 202 and one 409', async () => {
      await seed(20);
      const queued = await startRun();
      for (const url of ['/api/admin/search/reindex', '/api/admin/search/rollback']) {
        const res = await post(url).expect(409);
        expect(res.body).toMatchObject({ code: 'reindex_in_progress' });
        expect(JSON.stringify(res.body)).toContain(queued.runId);
      }

      const building = gate();
      t.probe.hooks.afterBuildingStarted = async () => {
        await building.wait();
      };
      const running = runOnce();
      await building.reached;
      expect((await run(queued.runId)).status).toBe('BUILDING');
      expect((await post('/api/admin/search/reindex').expect(409)).body.code).toBe('reindex_in_progress');
      building.release();

      const catching = gate();
      t.probe.hooks.beforeSwitch = async () => {
        await catching.wait();
      };
      await catching.reached;
      expect((await run(queued.runId)).status).toBe('CATCHING_UP');
      expect((await post('/api/admin/search/reindex').expect(409)).body.code).toBe('reindex_in_progress');
      catching.release();
      await running;
      expect((await run(queued.runId)).status).toBe('COMPLETED');

      const [a, b] = await Promise.all([
        post('/api/admin/search/reindex'),
        post('/api/admin/search/reindex'),
      ]);
      expect([a.status, b.status].sort()).toEqual([202, 409]);
      const active = await t.rows<{ n: string }>(
        `SELECT count(*) AS n FROM "SearchReindexRun" WHERE "status" IN ('QUEUED','BUILDING','CATCHING_UP')`,
      );
      expect(Number(active[0].n)).toBe(1);
    });

    it('S32 AS-43: cancel works in every active status, cleans the half-built index, leaves the live index alone; terminal runs answer 409, unknown 404, malformed 400', async () => {
      await seed(50);
      const liveBefore = await live();
      const indicesBefore = Object.keys(await t.indices()).sort();

      const queued = await startRun();
      const cancelledQueued = await post(`/api/admin/search/reindex/${queued.runId}/cancel`).expect(200);
      expect(cancelledQueued.body.status).toBe('CANCELLED');
      await runOnce(); // the job finds a cancelled run and does nothing
      expect(Object.keys(await t.indices()).sort()).toEqual(indicesBefore);

      const second = await startRun();
      const building = gate();
      t.probe.hooks.afterBuildingStarted = async () => {
        await building.wait();
      };
      const running = runOnce();
      await building.reached;
      expect(Object.keys(await t.indices()).length).toBe(indicesBefore.length + 1);
      await post(`/api/admin/search/reindex/${second.runId}/cancel`).expect(200);
      building.release();
      await running;
      expect((await run(second.runId)).status).toBe('CANCELLED');
      expect(Object.keys(await t.indices()).sort()).toEqual(indicesBefore);
      expect(await live()).toBe(liveBefore);
      expect((await history(second.runId)).map((h) => h.toStatus)).toContain('CANCELLED');

      const third = await startRun();
      const catching = gate();
      t.probe.hooks = {
        beforeSwitch: async () => {
          await catching.wait();
        },
      };
      const running3 = runOnce();
      await catching.reached;
      await post(`/api/admin/search/reindex/${third.runId}/cancel`).expect(200);
      catching.release();
      await running3;
      expect((await run(third.runId)).status).toBe('CANCELLED');
      expect(await live()).toBe(liveBefore);
      expect(Object.keys(await t.indices()).sort()).toEqual(indicesBefore);

      const terminal = await post(`/api/admin/search/reindex/${third.runId}/cancel`).expect(409);
      expect(terminal.body.code).toBe('invalid_transition');
      expect((await post(`/api/admin/search/reindex/${randomUUID()}/cancel`).expect(404)).body.code).toBe('run_not_found');
      await post('/api/admin/search/reindex/not-a-uuid/cancel').expect(400);
      await get('/api/admin/search/reindex/not-a-uuid').expect(400);
    });

    it('S32 AS-43: cancel racing the final switch ends consistently: either cancelled with the old index live, or completed with the new one live', async () => {
      await seed(30);
      const liveBefore = await live();
      const accepted = await startRun();
      const catching = gate();
      t.probe.hooks.beforeSwitch = async () => {
        await catching.wait();
      };
      const running = runOnce();
      await catching.reached;
      const [cancel] = await Promise.all([
        post(`/api/admin/search/reindex/${accepted.runId}/cancel`),
        (async () => {
          catching.release();
          await running;
        })(),
      ]);
      const final = await run(accepted.runId);
      if (final.status === 'CANCELLED') {
        expect(cancel.status).toBe(200);
        expect(await live()).toBe(liveBefore);
      } else {
        expect(final.status).toBe('COMPLETED');
        expect(cancel.status).toBe(409);
        expect(await live()).toBe(final.index);
      }
    });

    it('S32 AS-44: a built index with fewer documents than the history fails the run, deletes the half-built index and lets a new run start', async () => {
      await seed(40);
      const liveBefore = await live();
      const indicesBefore = Object.keys(await t.indices()).sort();
      const before = failed('verification_failed');
      t.probe.hooks.afterReplay = async (r) => {
        await t.es.indices.refresh({ index: r.index! });
        await t.es.deleteByQuery({
          index: r.index!,
          query: { terms: { title: ['gadget'] } },
          max_docs: 3,
          refresh: true,
        });
      };

      const accepted = await startRun();
      await runOnce();

      const done = await run(accepted.runId);
      expect(done).toMatchObject({ status: 'FAILED', failureReason: 'verification_failed' });
      expect(await live()).toBe(liveBefore);
      expect(Object.keys(await t.indices()).sort()).toEqual(indicesBefore);
      expect(failed('verification_failed')).toBe(before + 1);
      t.probe.reset();
      await startRun(); // a new run is accepted
    });

    it('S32 AS-44: a document the engine rejects while building fails the run with verification_failed', async () => {
      await seed(10);
      const bad = productEvent('created', snapshot({ productId: newId(), shopId, title: 'Poison', createdAt: 'not-a-date' }), t.clock.now());
      await t.publishHistory([bad]);
      const accepted = await startRun();
      await runOnce();
      expect(await run(accepted.runId)).toMatchObject({ status: 'FAILED', failureReason: 'verification_failed' });
    });

    it('S32 AS-44: an engine that goes away during the build fails the run with engine_unavailable and the live index is untouched', async () => {
      await seed(10);
      const liveBefore = await live();
      t.probe.hooks.afterBuildingStarted = async () => {
        t.proxy!.mode = 'refuse';
        t.proxy!.sever();
      };
      const accepted = await startRun();
      await runOnce();
      t.proxy!.mode = 'pass';
      const done = await run(accepted.runId);
      expect(done).toMatchObject({ status: 'FAILED', failureReason: 'engine_unavailable' });
      expect(await live()).toBe(liveBefore);
    });
  });

  describe('crash, rollback and retention (AS-45 to AS-47)', () => {
    it('S32 AS-45: a worker that dies mid-build is replaced by one that resumes from the saved position and ends with every product once', async () => {
      const ids = await seed(1_000);
      const accepted = await startRun();
      const executor = t.app.get(RunExecutorService, { strict: false });
      let writes = 0;
      t.probe.hooks.afterBatch = async (_r, batch) => {
        writes = batch;
        if (batch === 2) throw new SimulatedCrash();
      };
      await expect(executor.execute(accepted.runId)).rejects.toBeInstanceOf(SimulatedCrash);
      expect(writes).toBe(2);
      expect((await run(accepted.runId)).status).toBe('BUILDING');

      t.probe.hooks = {};
      await executor.execute(accepted.runId); // another worker claims the job
      const done = await run(accepted.runId);
      expect(done.status).toBe('COMPLETED');
      expect(Object.keys(await versions())).toHaveLength(ids.length);
      expect(await t.count()).toBe(ids.length);
    });

    it('S32 AS-45: a worker that dies after the switch is replaced by one that records COMPLETED without a second switch', async () => {
      await seed(30);
      const accepted = await startRun();
      const executor = t.app.get(RunExecutorService, { strict: false });
      t.probe.hooks.afterSwitch = async () => {
        throw new SimulatedCrash();
      };
      const switches = jest.spyOn(t.engine, 'updateAliases');
      await expect(executor.execute(accepted.runId)).rejects.toBeInstanceOf(SimulatedCrash);
      const crashed = await run(accepted.runId);
      expect(crashed.status).toBe('CATCHING_UP');
      expect(await live()).toBe(crashed.index);

      t.probe.hooks = {};
      await executor.execute(accepted.runId);
      const done = await run(accepted.runId);
      expect(done.status).toBe('COMPLETED');
      expect(done.previousIndex).not.toBeNull();
      expect(switches).toHaveBeenCalledTimes(1);
      expect(await live()).toBe(done.index);
    });

    it('S32 AS-46: a rollback points the live name back at the previous index, which already holds every later update; a second rollback rolls forward; none retained is 409', async () => {
      expect((await post('/api/admin/search/rollback').expect(409)).body.code).toBe('no_previous_index');
      await seed(25);
      const first = await startRun();
      await runOnce();
      const done = await run(first.runId);
      const [oldIndex, newIndex] = [done.previousIndex!, done.index!];

      const later = newId();
      await deliver(t.app).products(
        productEvent('created', snapshot({ productId: later, shopId, title: 'Added after the switch' }), t.clock.now()),
      );

      const rollback = reindexAcceptedSchema.parse((await post('/api/admin/search/rollback').expect(202)).body);
      expect(rollback.kind).toBe('ROLLBACK');
      await runOnce();
      expect(await run(rollback.runId)).toMatchObject({ status: 'COMPLETED', kind: 'ROLLBACK', index: oldIndex, previousIndex: newIndex });
      expect(await live()).toBe(oldIndex);
      expect(await t.doc(later)).not.toBeNull(); // written to the retained index in parallel

      const forward = reindexAcceptedSchema.parse((await post('/api/admin/search/rollback').expect(202)).body);
      await runOnce();
      expect(await run(forward.runId)).toMatchObject({ status: 'COMPLETED', index: newIndex });
      expect(await live()).toBe(newIndex);
    });

    it('S32 AS-47: the previous index is kept for 24 hours, then deleted by the job; the live index and an active run target are never deleted', async () => {
      await seed(10);
      const first = await startRun();
      await runOnce();
      const done = await run(first.runId);
      expect(done.status).toBe('COMPLETED');
      const job = t.app.get(RetirePreviousIndexJob, { strict: false });

      t.clock.advance(23 * HOUR);
      await t.reauth(adminUser);
      await job.retire();
      expect(await t.es.indices.exists({ index: done.previousIndex! })).toBe(true);

      t.clock.advance(HOUR + 1_000);
      await t.reauth(adminUser);
      const second = await startRun();
      const building = gate();
      t.probe.hooks.afterBuildingStarted = async () => {
        await building.wait();
      };
      const running = runOnce();
      await building.reached;
      const target = (await run(second.runId)).index!;
      await job.retire();
      expect(await t.es.indices.exists({ index: target })).toBe(true); // never an active run's target
      expect(await t.es.indices.exists({ index: await live() })).toBe(true);
      building.release();
      await running;

      const latest = await run(second.runId);
      t.clock.advance(25 * HOUR);
      await t.reauth(adminUser);
      await job.retire();
      expect(await t.es.indices.exists({ index: latest.previousIndex! })).toBe(false);
      expect(await t.es.indices.exists({ index: latest.index! })).toBe(true);
      expect((await post('/api/admin/search/rollback').expect(409)).body.code).toBe('no_previous_index');
      t.app.get(SearchIndexRegistry, { strict: false }).invalidate();
      expect(await t.app.get(SearchIndexRegistry, { strict: false }).writeSet()).toEqual([latest.index]);
    });
  });

  describe('legacy index, versions, first start and the shop table (AS-48 to AS-51)', () => {
    it('S32 AS-48: a concrete index named like the live name is replaced by the alias in one atomic step while searches keep answering', async () => {
      await t.es.indices.delete({ index: Object.keys(await t.indices()) });
      await t.es.indices.create({ index: 'products', ...productsIndexDefinition(TEST_PROFILE) } as never);
      t.app.get(SearchIndexRegistry, { strict: false }).invalidate();
      await seed(30);
      expect(Object.keys(await t.indices())).toEqual(['products']);

      const accepted = await startRun();
      const running = runOnce();
      const statuses: number[] = [];
      let finished = false;
      void running.finally(() => {
        finished = true;
      });
      while (!finished) {
        statuses.push((await t.http().get('/api/products/search').query({ q: 'gadget' })).status);
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(statuses.every((s) => s === 200)).toBe(true);
      const done = await run(accepted.runId);
      expect(done.status).toBe('COMPLETED');
      expect(await t.engine.aliasTargets('products')).toEqual([done.index]);
      expect(await t.es.indices.exists({ index: 'products' })).toBe(true); // the alias resolves
      expect(Object.keys(await t.indices())).not.toContain('products');
      expect(await t.count()).toBe(30);
    });

    it('S32 AS-49: an index built with an older mapping is reported outdated, nothing alters it at startup, and a run makes it current; vectors are carried when the model is the same and recomputed when it changed', async () => {
      await t.es.indices.delete({ index: Object.keys(await t.indices()) });
      const old = productsIndexDefinition(TEST_PROFILE);
      await t.es.indices.create({
        index: 'products_m0_legacy',
        ...old,
        mappings: { ...old.mappings, _meta: { mappingVersion: 0, embeddingModelVersion: 'old-model', createdByRun: null } },
        aliases: { products: {} },
      } as never);
      t.app.get(SearchIndexRegistry, { strict: false }).invalidate();
      await seed(5);

      await t.app.get(IndexBootstrapService, { strict: false }).ensureLiveIndex();
      expect(Object.keys(await t.indices())).toEqual(['products_m0_legacy']);
      const status = searchIndexStatusSchema.parse((await get('/api/admin/search/index').expect(200)).body);
      expect(status).toMatchObject({ outdated: true, mappingVersion: 0, expectedMappingVersion: MAPPING_VERSION, embeddingModelVersion: 'old-model' });

      t.embeddings.calls = [];
      const accepted = await startRun();
      await runOnce();
      expect((await run(accepted.runId)).status).toBe('COMPLETED');
      expect(t.embeddings.calls.length).toBeGreaterThanOrEqual(5); // the model changed: every vector recomputed
      const after = searchIndexStatusSchema.parse((await get('/api/admin/search/index').expect(200)).body);
      expect(after).toMatchObject({ outdated: false, mappingVersion: MAPPING_VERSION, embeddingModelVersion: t.embeddings.modelVersion });

      t.embeddings.calls = [];
      const again = await startRun();
      await runOnce();
      expect((await run(again.runId)).status).toBe('COMPLETED');
      expect(t.embeddings.calls).toHaveLength(0); // same model: vectors carried over
      expect((await t.doc((await Object.keys(await versions()))[0]))!.embedding).toHaveLength(64);
    });

    it('S32 AS-50: two instances starting at once leave one empty versioned index behind the live name; an existing live name is not touched; a first run fills the index', async () => {
      await t.es.indices.delete({ index: Object.keys(await t.indices()) });
      t.app.get(SearchIndexRegistry, { strict: false }).invalidate();
      const make = () =>
        new IndexBootstrapService(
          t.engine,
          t.app.get(SearchSettings, { strict: false }),
          t.app.get(IndexBootstrapService, { strict: false })['synonyms'],
        );
      await Promise.all([make().ensureLiveIndex(), make().ensureLiveIndex()]);
      const indices = await t.indices();
      expect(Object.keys(indices)).toHaveLength(1);
      expect(Object.values(indices)[0]).toEqual(['products']);
      expect((await t.http().get('/api/products/search')).body).toMatchObject({ items: [], total: { value: 0, exact: true } });
      expect(searchIndexStatusSchema.parse((await get('/api/admin/search/index').expect(200)).body).documentCount).toBe(0);

      await make().ensureLiveIndex();
      expect(await t.indices()).toEqual(indices);

      await seed(0);
      const events = Array.from({ length: 12 }, (_, i) =>
        productEvent('created', snapshot({ productId: newId(), shopId, title: `Late ${i}` }), t.clock.now()),
      );
      await t.publishHistory(events);
      const accepted = await startRun();
      await runOnce();
      expect(await run(accepted.runId)).toMatchObject({ status: 'COMPLETED', failureReason: null, documents: 12 });
      expect(await t.count()).toBe(12);
    });

    it('S32 AS-51: a run rebuilds the shop search table: missing rows return, deleted products have none alive, and no row goes back to an older version', async () => {
      const [kept, renamed, gone] = [newId(), newId(), newId()];
      const base = { shopId, quantity: 1 };
      const events = [
        productEvent('created', snapshot({ ...base, productId: kept, title: 'Kept', productVersion: 2 }), t.clock.now()),
        productEvent('updated', snapshot({ ...base, productId: renamed, title: 'Renamed new', productVersion: 2 }), t.clock.now()),
        productDeleted(gone, shopId, 3, t.clock.now()),
      ];
      await t.publishHistory(events);
      // the table already knows `renamed` at a NEWER version than the history
      await t.sequelize.query(
        `INSERT INTO "SearchShopProduct" ("productId","shopId","title","brand","status","priceMinor","currency","quantity","isSandbox","productVersion","updatedAt")
         VALUES ($1,$2,'Renamed newest','Acme','ACTIVE',1,'USD',1,false,9,now())`,
        { bind: [renamed, shopId] },
      );
      const accepted = await startRun();
      await runOnce();
      expect(await run(accepted.runId)).toMatchObject({ status: 'COMPLETED', failureReason: null });

      const rows = await t.rows<{ productId: string; title: string; productVersion: string; deletedAt: Date | null }>(
        `SELECT "productId", "title", "productVersion", "deletedAt" FROM "SearchShopProduct" ORDER BY "productId"`,
      );
      const byId = Object.fromEntries(rows.map((r) => [r.productId, r]));
      expect(byId[kept]).toMatchObject({ title: 'Kept', productVersion: '2', deletedAt: null });
      expect(byId[renamed]).toMatchObject({ title: 'Renamed newest', productVersion: '9' });
      expect(byId[gone].deletedAt).not.toBeNull();
    });
  });
});

void productDeleted;
void ({} as ReindexRun);
