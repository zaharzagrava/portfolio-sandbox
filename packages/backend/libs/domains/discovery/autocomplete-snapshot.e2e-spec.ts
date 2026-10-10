import { gunzipSync, gzipSync } from 'node:zlib';
import { v4 } from 'uuid';
import { suggestResponseSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { JobRegistry } from '@app/infrastructure/jobs/job-registry.service';
import { JobsService } from '@app/infrastructure/jobs';
import { JobsTestProbe } from '@app/infrastructure/jobs';
import {
  QUERY_INDEX_SNAPSHOT_STORE,
  SNAPSHOT_POINTER,
  type QueryIndexSnapshotStore,
  type SnapshotPointer,
} from './domain/autocomplete-ports';
import { decodeSnapshot, checksumOf } from './domain/snapshot-codec';
import {
  BUILD_LEASE_MS,
  BUILD_MAX_RUNTIME_MS,
} from './infra/autocomplete-builder.jobs';
import { AutocompleteSettings } from './infra/autocomplete-config';
import {
  closeNodes,
  createAutocompleteApp,
  startNode,
  type AutocompleteTestApp,
} from './testing/autocomplete-app';

// Build note (AS-34, S32 follow-up): the build never assumes per-query ordering in `search.performed`. S32 keys the event by
// `searchId`, so rows reach the log in any order; popularity is the exact number of distinct searchers per query,
// which does not depend on arrival order.

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;
const builds = (outcome: string) =>
  metric('autocomplete_builds_total', { outcome });
const failures = (reason: string) =>
  metric('autocomplete_snapshot_load_failures_total', { reason });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;

describe('Autocomplete snapshot build and hot swap', () => {
  let t: AutocompleteTestApp;
  let store: QueryIndexSnapshotStore;
  let pointer: SnapshotPointer;

  beforeAll(async () => {
    t = await createAutocompleteApp({ redisProxy: true });
    store = t.app.get<QueryIndexSnapshotStore>(QUERY_INDEX_SNAPSHOT_STORE, {
      strict: false,
    });
    pointer = t.app.get<SnapshotPointer>(SNAPSHOT_POINTER, { strict: false });
  });
  afterAll(() => closeNodes(t));
  beforeEach(async () => {
    t.redisProxy!.mode = 'pass';
    await t.resetAutocomplete();
    t.clock.set(new Date());
  });
  afterEach(() => jest.restoreAllMocks());

  const readSnapshot = async (version: string) =>
    decodeSnapshot((await store.get(version))!);
  const answer = async (node: AutocompleteTestApp, q: string) =>
    suggestResponseSchema.parse(
      (await node.http().get('/api/suggest').query({ q }).expect(200)).body,
    );
  const queries = async (node: AutocompleteTestApp, q: string) =>
    (await answer(node, q)).suggestions
      .filter((s) => s.source === 'query')
      .map((s) => s.text);

  describe('what a build keeps (AS-28 to AS-31)', () => {
    it('S33 AS-28: only eligible queries reach the snapshot: floor, results, blocklist, surface, personal data, form, window, duplicates', async () => {
      const eligible = {
        'iphone 17': 6,
        'iphone charger': 5,
        'usb c cable': 7,
        'airpods pro': 9,
        'wireless mouse': 6,
        'standing desk': 5,
        'laptop stand': 8,
      };
      for (const [q, n] of Object.entries(eligible)) await t.logQuery(q, n);
      await t.logQuery('rare thing', 4); // under the floor
      await t.logQuery('no results query', 10, { results: 0 });
      await t.logQuery('fake iphone', 9); // blocklist
      await t.logQuery('assistant lookup', 9, { surface: 'internal' });
      await t.logQuery('ann@example.com', 9); // legacy rows older than the redactor
      await t.logQuery('[redacted]', 9);
      await t.logQuery('call 555 123 456', 9);
      await t.logQuery('x', 9); // one character
      await t.logQuery('Mixed Case Query', 9); // not normalised
      await t.logQuery('old news', 9, {
        at: new Date(Date.now() - 40 * 86_400_000),
      });
      // six different people behind one event id are one search
      const eventId = v4();
      await t.clickhouse.getClient().insert({
        table: 'search_queries',
        format: 'JSONEachRow',
        values: Array.from({ length: 6 }, (_, i) => ({
          event_id: eventId,
          query: 'duplicated event',
          results: 5,
          user_hash: `u${i}`,
          ts: new Date(Date.now() - i * 1000).toISOString().replace('Z', ''),
        })),
      });

      const outcome = await t.build.build();

      expect(outcome).toMatchObject({ outcome: 'published', queries: 7 });
      const snapshot = await readSnapshot(
        (outcome as { version: string }).version,
      );
      expect(
        Object.fromEntries(snapshot.entries.map((e) => [e.query, e.searchers])),
      ).toEqual(eligible);
    });

    it('S33 AS-29: the snapshot is an immutable object with a verifying checksum, only queries and counts, and the pointer names it', async () => {
      await t.logQuery('iphone 17', 6);
      await t.logQuery('airpods pro', 8);
      const before = builds('published');

      const outcome = (await t.build.build()) as { version: string };

      expect(await t.snapshotVersions()).toEqual([
        `autocomplete/${outcome.version}.json.gz`,
      ]);
      expect(await t.pointer()).toBe(outcome.version);
      const bytes = (await store.get(outcome.version))!;
      const snapshot = decodeSnapshot(bytes);
      expect(snapshot.checksum).toBe(checksumOf(snapshot.entries));
      expect(snapshot.version).toBe(outcome.version);
      expect(snapshot.params).toEqual({
        windowDays: 30,
        minSearchers: 5,
        cap: 200_000,
        k: 10,
        depth: 20,
      });
      expect(snapshot.entries).toEqual([
        { query: 'airpods pro', searchers: 8 },
        { query: 'iphone 17', searchers: 6 },
      ]);
      expect(gunzipSync(bytes).toString('utf8')).not.toMatch(
        /user_hash|user|event_id/,
      );
      expect(builds('published')).toBe(before + 1);
    });

    it('S33 AS-30: a second run over the same log is unchanged: no new object, the pointer stays', async () => {
      await t.logQuery('iphone 17', 6);
      const first = (await t.build.build()) as { version: string };
      t.clock.advance(HOUR);
      const before = builds('unchanged');

      const second = await t.build.build();

      expect(second).toMatchObject({
        outcome: 'unchanged',
        version: first.version,
      });
      expect(await t.snapshotVersions()).toHaveLength(1);
      expect(await t.pointer()).toBe(first.version);
      expect(builds('unchanged')).toBe(before + 1);
    });

    it('S33 AS-31: an emptied log table publishes nothing and the pointer and the node stay as they were', async () => {
      await t.logQuery('iphone 17', 6);
      await t.publish();
      const [version, served] = [await t.pointer(), t.index.version];
      await t.clickhouse
        .getClient()
        .command({ query: 'TRUNCATE TABLE search_queries' });
      t.clock.advance(HOUR);
      const before = builds('skipped_empty');

      expect(await t.build.build()).toEqual({ outcome: 'skipped_empty' });
      await t.index.refresh();

      expect(await t.pointer()).toBe(version);
      expect(t.index.version).toBe(served);
      expect(await t.snapshotVersions()).toHaveLength(1);
      expect(builds('skipped_empty')).toBe(before + 1);
    });

    it('S33 AS-32: a log store that times out fails the run so the job retries, and nothing is published', async () => {
      await t.logQuery('iphone 17', 6);
      jest
        .spyOn(t.clickhouse.getClient(), 'query')
        .mockRejectedValue(new Error('Timeout error.'));
      const before = builds('failed');
      const jobs = t.app.get(JobsService);
      const { id } = await jobs.enqueue('search.build-autocomplete', {});

      await t.worker.runOnce();

      const job = (
        await new JobsTestProbe(t.sequelize).find('search.build-autocomplete')
      ).find((j) => j.id === id)!;
      expect(job.status).toBe('QUEUED'); // retriable: back in the queue for a later attempt
      expect(job.attempts).toBe(1);
      expect(await t.pointer()).toBeNull();
      expect(await t.snapshotVersions()).toEqual([]);
      expect(builds('failed')).toBe(before + 1);
      await jobs.cancel(id); // the retry is not part of the other scenarios
    });
  });

  describe('overlap, order, cap and retention (AS-33 to AS-37)', () => {
    it('S33 AS-33: of two overlapping builds the pointer ends on the newer one; the older is superseded and removes its object', async () => {
      await t.logQuery('iphone 17', 6);
      const realPut = store.put.bind(store);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reached = false;
      let held = false;
      jest.spyOn(store, 'put').mockImplementation(async (version, body) => {
        if (!held) {
          held = true;
          reached = true;
          await gate;
        }
        return realPut(version, body);
      });
      const before = {
        published: builds('published'),
        superseded: builds('superseded'),
      };

      const older = t.build.build(); // takes the first version, then waits before it writes
      while (!reached) await sleep(5);
      t.clock.advance(1_000);
      const newer = (await t.build.build()) as { version: string };
      release();
      const olderOutcome = await older;

      expect(newer).toMatchObject({ outcome: 'published' });
      expect(olderOutcome).toMatchObject({ outcome: 'superseded' });
      expect(await t.pointer()).toBe(newer.version);
      expect(await t.snapshotVersions()).toEqual([
        `autocomplete/${newer.version}.json.gz`,
      ]);
      expect(builds('published')).toBe(before.published + 1);
      expect(builds('superseded')).toBe(before.superseded + 1);
    });

    it('S33 AS-34: late and reversed rows give the same entries as an in-order log', async () => {
      const log = async (order: 'forward' | 'reverse') => {
        const batches = [
          ['iphone 17', 6],
          ['airpods pro', 8],
          ['usb c cable', 5],
        ] as const;
        for (const [q, n] of order === 'forward'
          ? batches
          : [...batches].reverse()) {
          const at = new Date(
            Date.now() - (order === 'forward' ? 1 : 3) * 60_000,
          );
          await t.logQuery(q, n, { at });
        }
      };
      await log('forward');
      const first = (await t.build.build()) as { version: string };
      const expected = (await readSnapshot(first.version)).entries;

      await t.clickhouse
        .getClient()
        .command({ query: 'TRUNCATE TABLE search_queries' });
      await log('reverse');
      t.clock.advance(HOUR);
      const second = await t.build.build();

      expect(second).toMatchObject({
        outcome: 'unchanged',
        version: first.version,
      }); // identical entries
      expect((await readSnapshot(first.version)).entries).toEqual(expected);
    });

    it('S33 AS-35: a cap keeps the most popular queries, ties broken by text', async () => {
      const capped = await startNode({ env: { AUTOCOMPLETE_CAP: '3' } });
      for (const [q, n] of [
        ['delta pack', 10],
        ['charlie pack', 8],
        ['bravo pack', 8],
        ['alpha pack', 8],
        ['echo pack', 6],
      ] as const)
        await t.logQuery(q, n);

      const outcome = (await capped.build.build()) as { version: string };

      expect((await readSnapshot(outcome.version)).entries).toEqual([
        { query: 'delta pack', searchers: 10 },
        { query: 'alpha pack', searchers: 8 },
        { query: 'bravo pack', searchers: 8 },
      ]);
    });

    it('S33 AS-36: the sixth publish leaves five versions, the pointed one among them', async () => {
      const versions: string[] = [];
      for (let i = 0; i < 6; i++) {
        await t.logQuery(`generation ${i}`, 6);
        t.clock.advance(2 * HOUR);
        versions.push(((await t.build.build()) as { version: string }).version);
      }
      const remaining = (await t.snapshotVersions()).map((k) =>
        k.replace(/^autocomplete\/|\.json\.gz$/g, ''),
      );
      expect(remaining.sort()).toEqual(versions.slice(1).sort());
      expect(remaining).toContain((await t.pointer())!);
    });

    it('S33 AS-36: an unreferenced object younger than the grace period is kept, and trimmed once it is old', async () => {
      const node = await startNode({
        env: { AUTOCOMPLETE_RETENTION_GRACE_MS: String(24 * HOUR) },
      });
      node.clock.set(new Date());
      const versions: string[] = [];
      for (let i = 0; i < 6; i++) {
        await t.logQuery(`young generation ${i}`, 6);
        node.clock.advance(2 * HOUR);
        versions.push(
          ((await node.build.build()) as { version: string }).version,
        );
      }
      expect(await t.snapshotVersions()).toHaveLength(6); // all young: the sixth object is beyond the five newest but kept

      await t.logQuery('young generation 7', 6);
      node.clock.advance(3 * 24 * HOUR);
      const last = ((await node.build.build()) as { version: string }).version;
      const remaining = (await t.snapshotVersions()).map((k) =>
        k.replace(/^autocomplete\/|\.json\.gz$/g, ''),
      );
      expect(remaining.sort()).toEqual([...versions.slice(2), last].sort());
    });

    it('S33 AS-37: the schedule exists once; two workers and a duplicate trigger run one build', async () => {
      const second = await startNode();
      const schedules = await t.rows<{ cron: string; jobType: string }>(
        `SELECT cron, "jobType" FROM "JobSchedule" WHERE name = 'search.build-autocomplete'`,
      );
      expect(schedules).toEqual([
        { cron: '7 * * * *', jobType: 'search.build-autocomplete' },
      ]);

      await t.logQuery('iphone 17', 6);
      const key = `autocomplete-build-${Date.now()}`;
      const jobs = t.app.get(JobsService);
      const first = await jobs.enqueue(
        'search.build-autocomplete',
        {},
        { idempotencyKey: key },
      );
      const duplicate = await jobs.enqueue(
        'search.build-autocomplete',
        {},
        { idempotencyKey: key },
      );
      expect(first.created).toBe(true);
      expect(duplicate).toEqual({ id: first.id, created: false });
      const before = builds('published') + builds('unchanged');

      await Promise.all([t.worker.runOnce(), second.worker.runOnce()]);

      expect(builds('published') + builds('unchanged')).toBe(before + 1);
      expect(await t.snapshotVersions()).toHaveLength(1);
    });

    it('S33 AS-37: the handler options are valid and the log query is cut off before the worker would stop the run', async () => {
      const handler = t.app
        .get(JobRegistry, { strict: false })
        .get('search.build-autocomplete')!;
      expect(handler).toMatchObject({
        leaseMs: BUILD_LEASE_MS,
        maxRuntimeMs: BUILD_MAX_RUNTIME_MS,
        concurrency: 1,
      });
      expect(handler.maxRuntimeMs).toBeGreaterThanOrEqual(handler.leaseMs);
      expect(
        t.app.get(AutocompleteSettings, { strict: false }).logQueryTimeoutMs,
      ).toBeLessThan(handler.maxRuntimeMs);
    });
  });

  describe('serving nodes follow the pointer (AS-41 to AS-47)', () => {
    /** Publishes one generation: `extra` more queries on top of what the log holds, a later clock instant. */
    const generation = async (
      node: AutocompleteTestApp,
      extra: Record<string, number>,
    ) => {
      for (const [q, n] of Object.entries(extra)) await t.logQuery(q, n);
      node.clock.advance(HOUR);
      const outcome = (await node.build.build()) as { version: string };
      expect(outcome).toMatchObject({ outcome: 'published' });
      return outcome.version;
    };

    it('S33 AS-41: while the pointer moves every answer is entirely the old snapshot or entirely the new one', async () => {
      const v1 = await generation(t, { 'sw alpha': 6, 'sw beta': 6 });
      await t.index.refresh();
      expect(t.index.version).toBe(v1);
      const versionBefore = metric('autocomplete_snapshot_version');
      const v2 = await generation(t, { 'sw gamma': 9, 'sw delta': 9 });

      const calls = Promise.all(
        Array.from({ length: 200 }, () => queries(t, 'sw')),
      );
      await sleep(5);
      await t.index.refresh();
      const answers = await calls;

      const old = ['sw alpha', 'sw beta'];
      const next = ['sw delta', 'sw gamma', 'sw alpha', 'sw beta'];
      for (const a of answers) expect([old, next]).toContainEqual(a);
      expect(t.index.version).toBe(v2);
      expect(await queries(t, 'sw')).toEqual(next);
      expect(metric('autocomplete_snapshot_version')).toBeGreaterThan(
        versionBefore,
      );
    });

    it('S33 AS-42: a damaged snapshot never replaces the one served; each poll retries once; a valid one recovers', async () => {
      await generation(t, { 'dm alpha': 6 });
      await t.index.refresh();
      const good = t.index.version!;
      const valid = (await store.get(good))!;
      const doc = JSON.parse(gunzipSync(valid).toString('utf8'));
      const cases: [string, Buffer][] = [
        [
          'checksum',
          gzipSync(
            JSON.stringify({
              ...doc,
              entries: [{ query: 'dm forged', searchers: 99 }],
            }),
          ),
        ],
        ['corrupt', Buffer.from('this is not a gzip stream')],
        ['format', gzipSync(JSON.stringify({ ...doc, format: 2 }))],
        [
          'invalid_entry',
          gzipSync(
            JSON.stringify({
              ...doc,
              entries: [{ query: 'dm', searchers: 0 }],
              checksum: checksumOf([{ query: 'dm', searchers: 0 }]),
            }),
          ),
        ],
      ];
      for (const [reason, bytes] of cases) {
        const bad = `${good}-bad-${reason}`;
        await store.put(bad, bytes);
        await pointer.forceSet(bad);
        const before = failures(reason);

        expect(await t.index.refresh()).toBe(false);
        expect(await t.index.refresh()).toBe(false); // the next poll tries the same version once more

        expect(failures(reason)).toBe(before + 2);
        expect(t.index.version).toBe(good);
        expect(await queries(t, 'dm')).toEqual(['dm alpha']);
      }

      const recovered = await generation(t, { 'dm beta': 7 });
      expect(await t.index.refresh()).toBe(true);
      expect(t.index.version).toBe(recovered);
      expect(await queries(t, 'dm')).toEqual(['dm beta', 'dm alpha']);
    });

    it('S33 AS-43: a pointer to a missing object is counted as missing and the node keeps serving', async () => {
      const v1 = await generation(t, { 'ms alpha': 6 });
      await t.index.refresh();
      await pointer.forceSet(`${v1}-gone`);
      const before = failures('missing');

      expect(await t.index.refresh()).toBe(false);

      expect(failures('missing')).toBe(before + 1);
      expect(t.index.version).toBe(v1);
      expect(await queries(t, 'ms')).toEqual(['ms alpha']);
    });

    it('S33 AS-44: a node that starts before any snapshot is ready, answers from the catalog, says query_index_unavailable, and loads the snapshot when it appears', async () => {
      const cold = await startNode();
      expect(cold.index.loaded).toBe(false);
      const res = await cold
        .http()
        .get('/api/suggest')
        .query({ q: 'iph' })
        .expect(200);
      expect(suggestResponseSchema.parse(res.body).degraded).toEqual([
        'query_index_unavailable',
      ]);
      expect(res.headers['cache-control']).toBe('no-store');

      await generation(t, { 'iphone cold': 6 });
      expect(await cold.index.refresh()).toBe(true);
      expect(cold.index.loaded).toBe(true);
      const warm = await cold
        .http()
        .get('/api/suggest')
        .query({ q: 'iphone c' })
        .expect(200);
      expect(suggestResponseSchema.parse(warm.body).suggestions).toContainEqual(
        { text: 'iphone cold', source: 'query' },
      );
      expect(warm.headers['cache-control']).toBe(
        'public, max-age=60, s-maxage=60',
      );
    });

    it('S33 AS-45: while the pointer store is down the node keeps serving and counts the failure; it recovers when the store returns', async () => {
      const v1 = await generation(t, { 'po alpha': 6 });
      await t.index.refresh();
      const before = failures('pointer_unreachable');

      t.redisProxy!.mode = 'refuse';
      t.redisProxy!.sever();
      expect(await t.index.refresh()).toBe(false);

      expect(failures('pointer_unreachable')).toBe(before + 1);
      expect(t.index.version).toBe(v1);
      expect(await queries(t, 'po')).toEqual(['po alpha']);

      t.redisProxy!.mode = 'pass';
      let v2 = '';
      for (let attempt = 0; attempt < 40 && !v2; attempt++) {
        try {
          await t.logQuery('po beta', 7);
          t.clock.advance(HOUR);
          const outcome = await t.build.build();
          if (outcome.outcome === 'published') v2 = outcome.version;
        } catch {
          await sleep(250); // the connection to the store is coming back
        }
      }
      expect(v2).not.toBe('');
      expect(await t.index.refresh()).toBe(true);
      expect(t.index.version).toBe(v2);
    });

    it('S33 AS-46: overlapping refreshes download once and share the result', async () => {
      await generation(t, { 'sf alpha': 6 });
      const downloads = jest.spyOn(t.storage, 'getStream');

      const results = await Promise.all([
        t.index.refresh(),
        t.index.refresh(),
        t.index.refresh(),
      ]);

      expect(results).toEqual([true, true, true]);
      expect(downloads).toHaveBeenCalledTimes(1);
      expect(await queries(t, 'sf')).toEqual(['sf alpha']);
    });

    it('S33 AS-47: setting the pointer back to an earlier version makes nodes load it', async () => {
      const v1 = await generation(t, { 'rb alpha': 6 });
      const v2 = await generation(t, { 'rb beta': 8 });
      await t.index.refresh();
      expect(t.index.version).toBe(v2);
      expect(await queries(t, 'rb')).toEqual(['rb beta', 'rb alpha']);

      expect(await pointer.compareAndSet(v1)).toBe(false); // the build path never goes back
      await pointer.forceSet(v1); // an operator may

      expect(await t.index.refresh()).toBe(true);
      expect(t.index.version).toBe(v1);
      expect(await queries(t, 'rb')).toEqual(['rb alpha']);
    });
  });
});
