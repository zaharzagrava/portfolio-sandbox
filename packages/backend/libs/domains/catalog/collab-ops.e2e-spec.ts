import * as Y from 'yjs';
import { v7 as uuidv7 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { JobsAdminService } from '@app/infrastructure/jobs/jobs-admin.service';
import { ReadinessService } from '@app/infrastructure/health';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { waitFor } from '@app/test/utils/async-helpers';
import { DraftsModule } from './drafts.module';
import { CollabModule } from './collab.module';
import { DraftsProjectorModule } from './drafts-projector.module';
import { CollabServer } from './api/collab-server.service';
import { DraftsJobs } from './infra/drafts.jobs';
import { snapshotKeyFor } from './infra/draft-store';
import { DRAFT_LIMITS } from './domain/draft-limits';
import {
  DOC_STORE,
  RING_REGISTRY,
  SNAPSHOT_STORE,
  SUPERSEDED_REGISTRY,
  type DocStore,
  type RingRegistry,
  type SnapshotStore,
  type SupersededRegistry,
} from './domain/draft-ports';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import { createShopWorld, type ShopWorld } from './testing/catalog-spec-kit';
import {
  announceRing,
  captureStdout,
  connectTo,
  openEditor,
  seedDraft,
  seedVersion,
} from './testing/draft-spec-kit';
import { YClient } from '@app/test/fakes/y-client';

const NOW = new Date('2026-03-01T10:00:00.000Z');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('Collab operations', () => {
  let t: CatalogTestApp;
  let proxy: TcpFaultProxy;
  let w: ShopWorld;
  let logs: ReturnType<typeof captureStdout>;
  let docs: DocStore;
  let objects: SnapshotStore;
  const open: YClient[] = [];

  beforeAll(async () => {
    logs = captureStdout(); // before the app: the structured logger binds its stream when it is created
    const redisUrl = new URL(
      process.env.REDIS_URL ?? 'redis://localhost:6400/0',
    );
    proxy = await TcpFaultProxy.start({
      host: redisUrl.hostname,
      port: Number(redisUrl.port || 6379),
    });
    t = await createCatalogApp({
      structuredLogger: true,
      extraImports: [DraftsModule, CollabModule, DraftsProjectorModule],
      redisUrl: `redis://127.0.0.1:${proxy.port}/${new URL(process.env.REDIS_URL ?? "redis://localhost:6400/0").pathname.slice(1) || "0"}`,
    });
    docs = t.app.get<DocStore>(DOC_STORE, { strict: false });
    objects = t.app.get<SnapshotStore>(SNAPSHOT_STORE, { strict: false });
  });
  afterAll(async () => {
    proxy.mode = 'pass';
    await t.close();
    await proxy.close();
    logs.restore();
  });
  beforeEach(async () => {
    await t.reset();
    t.clock.set(NOW);
    w = await createShopWorld(t);
    await announceRing(t.app);
  });
  afterEach(() => {
    open.splice(0).forEach((c) => c.close());
    jest.restoreAllMocks();
  });

  const editor = async (user: ShopWorld['owner'], draftId: string) => {
    const e = await openEditor(t, user, w.shop.id, draftId);
    open.push(e);
    await e.whenSynced();
    return e;
  };

  it('S06 AS-54: the metrics cover rooms, connections, updates by result and reason, flush and broadcast latency, closes by code, ring size, conflicts, snapshot reads and publish outcomes, carry no draft, shop or user label, and no log line holds a ticket, a document text or a token', async () => {
    const before = logs.length();
    const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
    const writer = await editor(w.staff, draft.id);
    const reader = await editor(w.viewer, draft.id);
    const connection = await connectTo(t, w.staff, w.shop.id, draft.id);
    const secret = 'confidential listing text 8c1f2';
    writer.doc.getText('title').insert(0, secret);
    writer.doc.getMap('fields').set('priceMinor', 1_000);
    writer.doc.getMap('fields').set('brand', 'Acme');
    writer.doc.getMap('fields').set('category', 'c');
    await waitFor(async () => reader.title() === secret);
    reader.doc.getText('title').insert(0, 'denied write');
    await waitFor(async () => reader.denied.length > 0);
    // A refused handshake, and a connection the server closes (a frame it cannot decode), so the closes metric has a code.
    const refused = new YClient(`${connection.url}?ticket=not-a-ticket`);
    await waitFor(async () => refused.refused !== null);
    reader.sendRaw(new Uint8Array([9, 9, 9]));
    await waitFor(async () => reader.closed !== null);
    expect(
      MetricsRegistry.value('collab_closes_total', { code: '4000' }),
    ).toBeGreaterThan(0);
    writer.awareness.setLocalState({ name: 'Ann' });
    await new Promise((r) => setTimeout(r, 300));
    const res = await t
      .as(w.staff)
      .post(`/api/shops/${w.shop.id}/drafts/${draft.id}/publish`)
      .set('Idempotency-Key', 'key-ops')
      .send({})
      .expect(200);
    expect(res.body.productId).toEqual(expect.any(String));

    const names: Array<[string, Record<string, string>?]> = [
      ['collab_rooms_open'],
      ['collab_connections_open'],
      ['collab_ring_size'],
      ['collab_updates_total', { result: 'accepted' }],
      ['collab_updates_total', { result: 'denied' }],
      ['collab_denied_writes_total', { reason: 'read_only' }],
      ['collab_sequence_conflicts_total'],
      ['collab_snapshot_reads_total'],
      ['drafts_publish_total', { outcome: 'published' }],
    ];
    for (const [name, labels] of names)
      expect([name, MetricsRegistry.value(name, labels ?? {})]).toEqual([
        name,
        expect.any(Number),
      ]);
    expect(
      MetricsRegistry.value('collab_updates_total', { result: 'accepted' }),
    ).toBeGreaterThan(0);
    expect(
      MetricsRegistry.value('collab_updates_total', { result: 'denied' }),
    ).toBeGreaterThan(0);
    expect(
      MetricsRegistry.value('drafts_publish_total', { outcome: 'published' }),
    ).toBeGreaterThan(0);
    expect(MetricsRegistry.value('collab_ring_size')).toBeGreaterThan(0);
    expect(
      MetricsRegistry.histogramValue('collab_flush_seconds')?.count,
    ).toBeGreaterThan(0);
    expect(
      MetricsRegistry.histogramValue('collab_broadcast_seconds')?.count,
    ).toBeGreaterThan(0);
    expect(
      MetricsRegistry.labelSets('collab_closes_total').length,
    ).toBeGreaterThan(0);

    for (const name of [
      'collab_rooms_open',
      'collab_connections_open',
      'collab_updates_total',
      'collab_denied_writes_total',
      'collab_flush_seconds',
      'collab_broadcast_seconds',
      'collab_closes_total',
      'collab_ring_size',
      'collab_store_errors_total',
      'drafts_publish_total',
    ])
      for (const labels of MetricsRegistry.labelSets(name)) {
        expect(
          Object.keys(labels).every((k) =>
            ['result', 'reason', 'code', 'outcome', 'operation'].includes(k),
          ),
        ).toBe(true);
        expect(Object.values(labels).some((v) => UUID.test(String(v)))).toBe(
          false,
        );
      }

    // Structured lines name the connection and the ids; none carries a ticket, a document text or a token.
    await waitFor(
      async () =>
        logs.lines(before).some((l) => JSON.stringify(l).includes('joined')),
      { timeoutMs: 3_000 },
    );
    const written = logs.text(before);
    const mine = logs
      .lines(before)
      .filter((l) =>
        ['joined', 'write_denied', 'handshake_refused'].some((e) =>
          JSON.stringify(l).includes(e),
        ),
      );
    expect(mine.length).toBeGreaterThanOrEqual(3);
    for (const line of mine) {
      const text = JSON.stringify(line);
      expect(text).toMatch(/"draftId"/);
      if (!text.includes('handshake_refused'))
        expect(text).toMatch(/"connectionId"/);
    }
    for (const forbidden of [
      secret,
      'denied write',
      connection.ticket,
      writer.url.split('ticket=')[1] ?? '--',
      t.clock && w.staff.bearer.replace('Bearer ', ''),
    ])
      if (forbidden && forbidden.length > 8)
        expect(written).not.toContain(forbidden);
  });

  describe('health and shutdown order (AS-55)', () => {
    const readyStatus = async () => {
      t.clock.advance(5_000); // the readiness report is cached for two seconds on the shared clock
      return t.http().get('/health/ready');
    };

    it('S06 AS-55: liveness answers 200 while the stores are down; readiness is 200 only while the instance is registered in the ring', async () => {
      await t.http().get('/health/live').expect(200);
      const ring = t.app.get<RingRegistry>(RING_REGISTRY, { strict: false });
      expect((await readyStatus()).status).toBe(200);

      const self = (await ring.members()).find(
        (m) => m.id === t.app.get(CollabServer).instanceId,
      )!;
      await ring.leave();
      const unregistered = await readyStatus();
      expect(unregistered.status).toBe(503);
      expect(unregistered.body.checks['collab-ring']).toBe('down');

      await ring.register(self); // joins the ring like at boot
      expect((await readyStatus()).status).toBe(200);
    });

    it('S06 AS-55: liveness stays 200 with the shared store cut off', async () => {
      proxy.mode = 'refuse';
      proxy.sever();
      try {
        await waitFor(
          async () => t.app.get(RedisService).client.status !== 'ready',
          { timeoutMs: 5_000, intervalMs: 20 },
        );
        await t.http().get('/health/live').expect(200);
      } finally {
        proxy.mode = 'pass';
        await waitFor(
          async () => (await t.app.get(RedisService).client.ping()) === 'PONG',
          {
            timeoutMs: 15_000,
            description: 'the store is back',
          },
        );
      }
    });

    it('S06 AS-55: on shutdown readiness fails first, the instance leaves the ring second, pending updates are flushed third and sockets close last', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const e = await editor(w.staff, draft.id);
      const ring = t.app.get<RingRegistry>(RING_REGISTRY, { strict: false });
      const self = (await ring.members()).find(
        (m) => m.id === t.app.get(CollabServer).instanceId,
      )!;
      const readiness = t.app.get(ReadinessService);
      const timeline: string[] = [];

      const leave = ring.leave.bind(ring);
      jest.spyOn(ring, 'leave').mockImplementation(async () => {
        timeline.push(
          readiness.isShuttingDown()
            ? 'ring left (readiness already failing)'
            : 'ring left (readiness still up)',
        );
        await leave();
      });
      const append = docs.append.bind(docs);
      jest.spyOn(docs, 'append').mockImplementation(async (...args) => {
        timeline.push(`flush (ring registered: ${ring.registered()})`);
        return append(...args);
      });

      e.doc.getText('title').insert(0, 'pending at shutdown');
      readiness.markShuttingDown();
      timeline.push('readiness failing');
      expect((await t.http().get('/health/ready')).status).toBe(503);
      await t.app.get(ShutdownRegistry).run('drain');
      await waitFor(async () => e.closed !== null);
      timeline.push(`socket closed ${e.closed!.code}`);

      expect(timeline).toEqual([
        'readiness failing',
        'ring left (readiness already failing)',
        'flush (ring registered: false)',
        'socket closed 1012',
      ]);
      expect(
        (await docs.load(w.shop.id, draft.id)).doc.getText('title').toString(),
      ).toBe('pending at shutdown');

      // The process stays up in this spec: put the instance back so the specs after this one find a registered instance.
      readiness.resetShuttingDown();
      await ring.register(self);
    });
  });

  describe('leftover cleanup (AS-56)', () => {
    it('S06 AS-56: superseded snapshots past their grace and unreferenced version objects older than an hour are deleted, referenced objects are kept, and a second run changes nothing', async () => {
      const jobs = t.app.get(DraftsJobs);
      const superseded = t.app.get<SupersededRegistry>(SUPERSEDED_REGISTRY, {
        strict: false,
      });
      // The graces count on the shared clock from the moment of the compaction; the stored objects carry real times.
      t.clock.set(new Date());

      // Two compactions: the first snapshot is superseded by the second.
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const first = new Y.Doc();
      first.getText('title').insert(0, 'one');
      await docs.append(draft.id, 1, Y.encodeStateAsUpdate(first));
      await docs.compact(w.shop.id, draft.id, first, 1);
      first.getText('title').insert(3, ' two');
      await docs.append(draft.id, 2, Y.encodeStateAsUpdate(first));
      await docs.compact(w.shop.id, draft.id, first, 2);
      const old = snapshotKeyFor(draft.id, 1);
      const current = snapshotKeyFor(draft.id, 2);
      expect((await objects.get(old)).byteLength).toBeGreaterThan(0);

      // Version objects: one referenced by a row, two without any row.
      const referenced = await seedVersion(t.app, draft, w.owner.id);
      const orphanA = `versions/${uuidv7()}`;
      const orphanB = `versions/${uuidv7()}`;
      await objects.put(orphanA, new Uint8Array([1, 2, 3]));
      await objects.put(orphanB, new Uint8Array([4, 5, 6]));

      // Inside the grace periods nothing is deleted.
      t.clock.set(new Date(Date.now() + 5 * 60_000));
      expect(await jobs.purgeSuperseded()).toMatchObject({ orphans: 0 });
      expect((await objects.get(old)).byteLength).toBeGreaterThan(0);
      expect((await objects.get(orphanA)).byteLength).toBe(3);

      // After the grace (10 minutes for a snapshot, 1 hour for an object nobody references).
      t.clock.set(
        new Date(Date.now() + DRAFT_LIMITS.orphanObjectAgeMs + 2 * 60_000),
      );
      const run = await jobs.purgeSuperseded();
      expect(run.superseded).toBeGreaterThanOrEqual(1);
      expect(run.orphans).toBeGreaterThanOrEqual(2);
      await expect(objects.get(old)).rejects.toBeDefined();
      await expect(objects.get(orphanA)).rejects.toBeDefined();
      await expect(objects.get(orphanB)).rejects.toBeDefined();
      expect((await objects.get(current)).byteLength).toBeGreaterThan(0); // referenced by the pointer
      expect(
        (await objects.get(`versions/${referenced}`)).byteLength,
      ).toBeGreaterThan(0); // referenced by a row

      const again = await jobs.purgeSuperseded();
      expect(again.orphans).toBe(0);
      expect(
        (await superseded.due(new Date(8.64e15), 100)).some(
          (d) => d.key === old,
        ),
      ).toBe(false);
      expect((await objects.get(current)).byteLength).toBeGreaterThan(0);
    });

    it('S06 AS-56: both jobs are registered with the scheduler and the stale-lease job is idempotent', async () => {
      // The tables were emptied by `reset`: register the schedules again the way the application does at start.
      await t.app.get(DraftsJobs).onApplicationBootstrap();
      const schedules = await t.app
        .get(JobsAdminService, { strict: false })
        .listSchedules();
      const mine = schedules.filter((s) => s.name.startsWith('drafts.'));
      expect(mine.map((s) => [s.name, s.cron, s.enabled]).sort()).toEqual([
        ['drafts.purge-superseded-snapshots', '0 4 * * *', true],
        ['drafts.release-stale-publishing', '* * * * *', true],
      ]);
      const jobs = t.app.get(DraftsJobs);
      expect(await jobs.releaseStalePublishing()).toEqual({ released: 0 });
      expect(await jobs.releaseStalePublishing()).toEqual({ released: 0 });
    });
  });
});
