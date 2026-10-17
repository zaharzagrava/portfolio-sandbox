import * as Y from 'yjs';
import { v7 as uuidv7 } from 'uuid';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { YClient } from '@app/test/fakes/y-client';
import { waitFor } from '@app/test/utils/async-helpers';
import { CollabServer } from './api/collab-server.service';
import { RoomManager } from './application/room-manager.service';
import { CollabModule } from './collab.module';
import { DraftsModule } from './drafts.module';
import { DraftsProjectorModule } from './drafts-projector.module';
import {
  COLLAB_TIMINGS,
  DEFAULT_COLLAB_TIMINGS,
  type CollabTimings,
} from './domain/draft-limits';
import { HashRing } from './domain/hash-ring';
import {
  DOC_STORE,
  RING_REGISTRY,
  type DocStore,
  type RingRegistry,
} from './domain/draft-ports';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import { createShopWorld, type ShopWorld } from './testing/catalog-spec-kit';
import {
  announceRing,
  captureStdout,
  connectTo,
  draftRow,
  logSeqs,
  addUsers,
  openEditor,
  seedDraft,
  settleRing,
} from './testing/draft-spec-kit';

const NOW = new Date('2026-03-01T10:00:00.000Z');
const TIMINGS: CollabTimings = {
  ...DEFAULT_COLLAB_TIMINGS,
  flushBatchMs: 25,
  retryBaseMs: 10,
  retryCapMs: 200,
  idleUnloadMs: 300,
};
const modules = [DraftsModule, CollabModule, DraftsProjectorModule];

const instance = (
  id: string,
  extra: { env?: Record<string, string>; redisUrl?: string } = {},
) =>
  createCatalogApp({
    extraImports: modules,
    env: { COLLAB_INSTANCE_ID: id, ...extra.env },
    redisUrl: extra.redisUrl,
    overrides: [{ provide: COLLAB_TIMINGS, useValue: TIMINGS }],
  });

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

const ringOf = (t: CatalogTestApp) =>
  t.app.get<RingRegistry>(RING_REGISTRY, { strict: false });
const storeOf = (t: CatalogTestApp) =>
  t.app.get<DocStore>(DOC_STORE, { strict: false });

/** Ids that the ring of these instances gives to each of them. */
function idsFor(members: string[], perMember = 1): Record<string, string[]> {
  const ring = new HashRing(members);
  const found: Record<string, string[]> = Object.fromEntries(
    members.map((m) => [m, []]),
  );
  while (members.some((m) => found[m].length < perMember)) {
    const id = uuidv7();
    const owner = ring.nodeFor(id)!;
    if (found[owner].length < perMember) found[owner].push(id);
  }
  return found;
}

describe('Collab routing and durability', () => {
  // ------------------------------------------------------------------------------------ two instances

  describe('between two instances', () => {
    let a: CatalogTestApp;
    let b: CatalogTestApp;
    let w: ShopWorld;
    const open: YClient[] = [];

    beforeAll(async () => {
      a = await instance('inst-a');
      b = await instance('inst-b');
    });
    afterAll(async () => {
      await a.close();
      await b.close();
    });
    beforeEach(async () => {
      await a.reset();
      a.clock.set(NOW);
      b.clock.set(NOW);
      w = await createShopWorld(a);
      await announceRing(a.app);
      await announceRing(b.app);
      await settleRing(a.app, b.app);
    });
    afterEach(() => open.splice(0).forEach((c) => c.close()));

    it('S06 AS-46: an instance that does not own the draft closes with 4001 and the owner address without loading a room or consuming the ticket, and the same ticket works at the owner', async () => {
      const ids = idsFor(['inst-a', 'inst-b']);
      const onA = await seedDraft(a.app, w.shop.id, w.owner.id, {
        id: ids['inst-a'][0],
      });
      const onB = await seedDraft(a.app, w.shop.id, w.owner.id, {
        id: ids['inst-b'][0],
      });
      const aBase = (
        await connectTo(a, w.staff, w.shop.id, onA.id)
      ).url.replace(/\/collab\/.*/, '');
      const ticketForB = await connectTo(a, w.staff, w.shop.id, onB.id);
      expect(ticketForB.url).not.toContain(aBase);

      const wrong = new YClient(
        `${aBase}/collab/${onB.id}?ticket=${ticketForB.ticket}`,
      );
      open.push(wrong);
      await waitFor(async () => wrong.closed !== null, {
        description: 'redirected',
      });
      expect(wrong.closed!.code).toBe(4001);
      expect(wrong.closed!.reason).toBe(
        ticketForB.url.replace(/\/collab\/.*/, ''),
      );
      expect(a.app.get(RoomManager).roomOf(onB.id)).toBeUndefined();
      expect(a.app.get(RoomManager).count()).toBe(0);

      const right = new YClient(
        `${wrong.closed!.reason}/collab/${onB.id}?ticket=${ticketForB.ticket}`,
      );
      open.push(right);
      await right.whenSynced();
      expect(b.app.get(RoomManager).roomOf(onB.id)).toBeDefined();
    });

    it('S06 AS-48: when a 5th instance registers, every process routes by the new ring and the rooms that moved flush and close with 4001 and the new owner address, nothing else closes, and no sequence conflict occurs', async () => {
      const ringB = ringOf(b);
      const self = (await ringB.members()).find((m) => m.id === 'inst-b')!;
      await ringB.leave();
      const redis = a.app.get(RedisService).client;
      const ghosts = ['ghost-1', 'ghost-2', 'ghost-3'];
      for (const g of ghosts)
        await redis.zadd(
          'collab:ring',
          NOW.getTime(),
          `${g}|ws://${g}.invalid:1`,
        );
      await ringOf(a).refreshNow();
      expect((await ringOf(a).members()).map((m) => m.id).sort()).toEqual([
        'ghost-1',
        'ghost-2',
        'ghost-3',
        'inst-a',
      ]);

      // 30 drafts that the 4-instance fleet gives to inst-a, each with a live editor.
      const before = new HashRing(['inst-a', ...ghosts]);
      const owned: string[] = [];
      while (owned.length < 30) {
        const id = uuidv7();
        if (before.nodeFor(id) === 'inst-a') owned.push(id);
      }
      const editors = new Map<string, YClient>();
      const users = await addUsers(a, w.shop.id, 5); // connect is limited to 30 a minute per user
      let turn = 0;
      for (const id of owned) {
        await seedDraft(a.app, w.shop.id, w.owner.id, { id });
        const editor = await openEditor(
          a,
          users[turn++ % users.length],
          w.shop.id,
          id,
        );
        open.push(editor);
        editors.set(id, editor);
      }
      for (const editor of editors.values()) await editor.whenSynced();
      for (const [id, editor] of editors)
        editor.doc.getText('title').insert(0, `d-${id.slice(-4)}`);
      const conflicts = metric('collab_sequence_conflicts_total');

      await ringB.register(self);
      const after = new HashRing(['inst-a', 'inst-b', ...ghosts]);
      const moved = owned.filter((id) => after.nodeFor(id) !== 'inst-a');
      expect(moved.length).toBeGreaterThan(0);
      expect(moved.every((id) => after.nodeFor(id) === 'inst-b')).toBe(true);
      expect(moved.length / owned.length).toBeLessThanOrEqual(1 / 5 + 0.2);

      await waitFor(
        async () => moved.every((id) => editors.get(id)!.closed !== null),
        {
          timeoutMs: 10_000,
          description: 'moved rooms closed',
        },
      );
      for (const id of moved) {
        expect(editors.get(id)!.closed!.code).toBe(4001);
        expect(editors.get(id)!.closed!.reason).toBe(self.url);
      }
      for (const id of owned.filter((x) => !moved.includes(x)))
        expect(editors.get(id)!.closed).toBeNull();
      // Their edits were flushed before the sockets closed, and the other process routes by the new ring too.
      for (const id of moved)
        expect(
          (await storeOf(a).load(w.shop.id, id)).doc
            .getText('title')
            .toString(),
        ).toBe(`d-${id.slice(-4)}`);
      expect((await ringOf(b).ownerOf(moved[0]))!.id).toBe('inst-b');
      expect(metric('collab_sequence_conflicts_total')).toBe(conflicts);
      // A client calls connect again and reaches the new owner.
      const again = await connectTo(a, users[0], w.shop.id, moved[0]);
      expect(again.url).toContain(self.url);
      await redis.zrem(
        'collab:ring',
        ...ghosts.map((g) => `${g}|ws://${g}.invalid:1`),
      );
    }, 120_000);
  });

  // ------------------------------------------------------------------------------------ split brain

  describe('split brain', () => {
    let a: CatalogTestApp;
    let b: CatalogTestApp;
    let w: ShopWorld;
    const open: YClient[] = [];

    beforeAll(async () => {
      a = await instance('inst-a');
      b = await instance('inst-b');
    });
    afterAll(async () => {
      jest.restoreAllMocks();
      await a.close();
      await b.close();
    });
    beforeEach(async () => {
      await a.reset();
      a.clock.set(NOW);
      b.clock.set(NOW);
      w = await createShopWorld(a);
      await announceRing(a.app);
      await announceRing(b.app);
      await settleRing(a.app, b.app);
    });
    afterEach(() => {
      open.splice(0).forEach((c) => c.close());
      jest.restoreAllMocks();
    });

    it('S06 AS-49: two rooms for one draft write each sequence number once; the loser closes its sockets with 4002 and is evicted, loses nothing, and the owner ends with the edits of both', async () => {
      const draft = await seedDraft(a.app, w.shop.id, w.owner.id);
      // Both instances believe they own the draft for a moment: their ring views disagree.
      for (const t of [a, b]) {
        const ring = ringOf(t);
        const member = (await ring.members()).find(
          (m) => m.id === (t === a ? 'inst-a' : 'inst-b'),
        )!;
        jest.spyOn(ring, 'ownerOf').mockResolvedValue(member);
      }
      const urlOf = async (t: CatalogTestApp) =>
        (await ringOf(t).members()).find(
          (m) => m.id === (t === a ? 'inst-a' : 'inst-b'),
        )!.url;
      const join = async (
        t: CatalogTestApp,
        user: typeof w.staff,
        doc?: Y.Doc,
      ) => {
        const ticket = (
          await a
            .as(user)
            .post(`/api/shops/${w.shop.id}/drafts/${draft.id}/connect`)
            .expect(200)
        ).body.ticket;
        const client = new YClient(
          `${await urlOf(t)}/collab/${draft.id}?ticket=${ticket}`,
          { doc },
        );
        open.push(client);
        await client.whenSynced();
        return client;
      };
      const onA = await join(a, w.staff);
      const onB = await join(b, w.admin);
      const conflicts = metric('collab_sequence_conflicts_total');

      onA.doc.getText('title').insert(0, 'from-A ');
      await waitFor(async () => (await logSeqs(a.app, draft.id)).length === 1, {
        description: 'A wrote sequence 1',
      });
      onB.doc.getText('description').insert(0, 'from-B');
      await waitFor(async () => onB.closed !== null, {
        timeoutMs: 10_000,
        description: 'the loser room closed',
      });
      expect(onB.closed!.code).toBe(4002);
      expect(onA.closed).toBeNull();
      expect(metric('collab_sequence_conflicts_total')).toBe(conflicts + 1);
      expect(b.app.get(RoomManager).roomOf(draft.id)).toBeUndefined();
      expect(await logSeqs(a.app, draft.id)).toEqual([1]); // no fork: one writer per sequence number

      // The loser's client reconnects through connect (the ring agrees again) and its edit is merged.
      jest.restoreAllMocks();
      await ringOf(a).refreshNow();
      const reconnected = await openEditor(a, w.admin, w.shop.id, draft.id, {
        doc: onB.doc,
      });
      open.push(reconnected);
      await reconnected.whenSynced();
      await waitFor(
        async () => {
          const doc = (await storeOf(a).load(w.shop.id, draft.id)).doc;
          return (
            doc.getText('title').toString().includes('from-A') &&
            doc.getText('description').toString() === 'from-B'
          );
        },
        { description: 'both edits in the owner state' },
      );
    }, 60_000);
  });

  // ------------------------------------------------------------------------------------ durability

  describe('durability against a fault proxy on the log store', () => {
    let proxy: TcpFaultProxy;
    let t: CatalogTestApp;
    let w: ShopWorld;
    let viewerLogs: ReturnType<typeof captureStdout>;
    const open: YClient[] = [];

    beforeAll(async () => {
      viewerLogs = captureStdout();
      const url = new URL(
        process.env.DYNAMO_ENDPOINT ?? 'http://localhost:8101',
      );
      proxy = await TcpFaultProxy.start({
        host: url.hostname,
        port: Number(url.port || 80),
      });
      t = await instance('inst-a', {
        env: { DYNAMO_ENDPOINT: `http://127.0.0.1:${proxy.port}` },
      });
    });
    afterAll(async () => {
      proxy.mode = 'pass';
      jest.restoreAllMocks();
      await t.close();
      await proxy.close();
      viewerLogs.restore();
    });
    beforeEach(async () => {
      proxy.mode = 'pass';
      proxy.delayMs = 0;
      await t.reset();
      t.clock.set(NOW);
      w = await createShopWorld(t);
      await announceRing(t.app);
    });
    afterEach(() => {
      proxy.mode = 'pass';
      open.splice(0).forEach((c) => c.close());
      jest.restoreAllMocks();
    });

    const editorOn = async (draftId: string, user = w.staff, doc?: Y.Doc) => {
      const e = await openEditor(t, user, w.shop.id, draftId, { doc });
      open.push(e);
      await e.whenSynced();
      return e;
    };
    const loaded = async (draftId: string) =>
      (await storeOf(t).load(w.shop.id, draftId)).doc;

    it('S06 AS-50: every update is broadcast at once; the updates of one window are one log entry; the document rebuilt from snapshot and log equals the live one', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const a = await editorOn(draft.id);
      const b = await editorOn(draft.id, w.admin);

      for (let i = 0; i < 20; i++)
        a.doc
          .getText('title')
          .insert(a.doc.getText('title').length, `${i % 10}`);
      await waitFor(async () => b.title() === a.title(), {
        description: 'broadcast',
      });
      await waitFor(async () => (await logSeqs(t.app, draft.id)).length >= 1);
      await new Promise((r) => setTimeout(r, 300));
      expect(await logSeqs(t.app, draft.id)).toHaveLength(1); // 20 updates, one window, one entry

      a.doc.getText('title').insert(0, 'next window ');
      await waitFor(async () => (await logSeqs(t.app, draft.id)).length === 2);
      const rebuilt = await loaded(draft.id);
      expect(rebuilt.getText('title').toString()).toBe(a.title());
      expect(Y.encodeStateVector(rebuilt)).toEqual(Y.encodeStateVector(a.doc));
    });

    it('S06 AS-51: after 200 flushes the state is a snapshot at that sequence, the pointer only moves forward, the log is trimmed, and a crash between pointer and trim leaves a correct load that the next compaction cleans', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const editor = await editorOn(draft.id);
      for (let i = 1; i <= 200; i++) {
        // The frame-rate window follows the shared clock, which a spec holds still: let it run for a second now and then.
        if (i % 100 === 0) t.clock.advance(1_100);
        editor.doc
          .getText('title')
          .insert(editor.doc.getText('title').length, 'x');
        const wantedSeq = i;
        await waitFor(
          async () => {
            const seqs = await logSeqs(t.app, draft.id);
            const row = await draftRow<{ snapshotSeq: string }>(
              t.app,
              draft.id,
            );
            return Math.max(0, ...seqs, Number(row!.snapshotSeq)) >= wantedSeq;
          },
          { intervalMs: 5, description: `flush ${i}` },
        );
      }
      await waitFor(
        async () =>
          Number(
            (await draftRow<{ snapshotSeq: string }>(t.app, draft.id))!
              .snapshotSeq,
          ) === 200,
        {
          description: 'compaction at flush 200',
        },
      );
      const row = await draftRow<{ snapshotSeq: string; snapshotKey: string }>(
        t.app,
        draft.id,
      );
      expect(row!.snapshotKey).toMatch(
        new RegExp(`drafts/${draft.id}/snap-0*200$`),
      );
      // The trim follows the pointer move.
      await waitFor(
        async () =>
          (await logSeqs(t.app, draft.id)).filter((s) => s <= 200).length === 0,
        {
          description: 'the log trimmed up to the snapshot',
        },
      );
      expect((await loaded(draft.id)).getText('title').length).toBe(200);

      // A compaction with a lower sequence number never moves the pointer back.
      const store = storeOf(t);
      await store.compact(w.shop.id, draft.id, await loaded(draft.id), 150);
      expect(
        await draftRow<{ snapshotSeq: string; snapshotKey: string }>(
          t.app,
          draft.id,
        ),
      ).toMatchObject({
        snapshotSeq: '200',
        snapshotKey: row!.snapshotKey,
      });

      // A crash between moving the pointer and trimming: the leftovers are ignored by the load.
      editor.doc.getText('title').insert(0, 'y');
      await waitFor(async () => (await logSeqs(t.app, draft.id)).includes(201));
      const trim = jest
        .spyOn(store as unknown as { trim: () => Promise<number> }, 'trim')
        .mockRejectedValueOnce(new Error('crash'));
      await expect(
        store.compact(w.shop.id, draft.id, await loaded(draft.id), 201),
      ).rejects.toThrow('crash');
      expect(trim).toHaveBeenCalledTimes(1);
      expect(
        Number(
          (await draftRow<{ snapshotSeq: string }>(t.app, draft.id))!
            .snapshotSeq,
        ),
      ).toBe(201);
      expect(await logSeqs(t.app, draft.id)).toContain(201); // not trimmed
      expect((await loaded(draft.id)).getText('title').toString()).toBe(
        `y${'x'.repeat(200)}`,
      );
      jest.restoreAllMocks();
      await store.compact(w.shop.id, draft.id, await loaded(draft.id), 201);
      expect(await logSeqs(t.app, draft.id)).toEqual([]);
    }, 180_000);

    it('S06 AS-52: a log write that times out twice is retried and persisted with the pending updates kept and no client closed', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const editor = await editorOn(draft.id);
      const errors = metric('collab_store_errors_total', {
        operation: 'flush',
      });
      proxy.mode = 'hang';
      editor.doc.getText('title').insert(0, 'kept while the store hangs');
      await waitFor(
        async () =>
          metric('collab_store_errors_total', { operation: 'flush' }) >=
          errors + 2,
        {
          timeoutMs: 20_000,
          description: 'two timeouts',
        },
      );
      proxy.mode = 'pass';
      await waitFor(
        async () =>
          (await loaded(draft.id)).getText('title').toString() ===
          'kept while the store hangs',
        {
          timeoutMs: 20_000,
          description: 'persisted after the store answers',
        },
      );
      expect(editor.closed).toBeNull();
      expect(await logSeqs(t.app, draft.id)).toEqual([1]);
    }, 90_000);

    it('S06 AS-52: a write that landed but whose acknowledgement was lost counts as a success: identical bytes at the same sequence, no eviction', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const editor = await editorOn(draft.id);
      const conflicts = metric('collab_sequence_conflicts_total');
      proxy.dropNextResponses(1);
      editor.doc.getText('title').insert(0, 'acknowledged late');
      await waitFor(async () => (await logSeqs(t.app, draft.id)).length === 1, {
        timeoutMs: 20_000,
      });
      await waitFor(
        () =>
          Promise.resolve(
            !t.app.get(RoomManager).roomOf(draft.id)?.backlogBytes,
          ),
        {
          timeoutMs: 20_000,
          description: 'the retry found its own bytes and finished',
        },
      );
      expect(editor.closed).toBeNull();
      expect(metric('collab_sequence_conflicts_total')).toBe(conflicts);
      expect(await logSeqs(t.app, draft.id)).toEqual([1]);
      expect((await loaded(draft.id)).getText('title').toString()).toBe(
        'acknowledged late',
      );
    }, 60_000);

    it('S06 AS-52: when the store stays down past the backlog limit writers close with 4013 while read-only connections continue; writes work again after the store answers', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const writer = await editorOn(draft.id);
      const reader = await editorOn(draft.id, w.viewer);
      proxy.mode = 'refuse';
      proxy.sever();
      writer.doc.getText('title').insert(0, 'pending during the outage');
      await waitFor(
        async () =>
          metric('collab_store_errors_total', { operation: 'flush' }) > 0,
        { timeoutMs: 20_000 },
      );
      expect(writer.closed).toBeNull();

      // The backlog becomes older than 30 seconds (the shared clock moves; the room looks again at every retry).
      await waitFor(
        async () => {
          t.clock.advance(31_000);
          await new Promise((r) => setTimeout(r, 300));
          return writer.closed !== null;
        },
        { timeoutMs: 20_000, intervalMs: 50, description: 'writer closed' },
      );
      expect(writer.closed!.code).toBe(4013);
      expect(reader.closed).toBeNull();

      proxy.mode = 'pass';
      await ringOf(t).heartbeatNow(); // the clock moved: announce the instance again
      await waitFor(
        async () =>
          (await loaded(draft.id)).getText('title').toString() ===
          'pending during the outage',
        {
          timeoutMs: 30_000,
          description: 'the pending update reached the store',
        },
      );
      const again = await editorOn(draft.id);
      again.doc.getText('title').insert(0, 'after ');
      await waitFor(async () =>
        (await loaded(draft.id))
          .getText('title')
          .toString()
          .startsWith('after '),
      );
    }, 120_000);

    it('S06 AS-53: an update of 400 KB is stored as several entries of at most 300 KB in order, and a reload equals the live document', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const editor = await editorOn(draft.id);
      const text = 'q'.repeat(400_000);
      editor.doc.getText('description').insert(0, text);
      await waitFor(async () => (await logSeqs(t.app, draft.id)).length >= 2, {
        timeoutMs: 20_000,
      });
      const dynamo = t.app.get(DynamoService);
      const items = (
        await dynamo.doc.send(
          new QueryCommand({
            TableName: dynamo.table('DocUpdates'),
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: { ':pk': `DOC#${draft.id}` },
            ConsistentRead: true,
          }),
        )
      ).Items!;
      expect(items.map((i) => Number(i.SK))).toEqual(
        items.map((_, i) => i + 1),
      );
      expect(
        items.every((i) => (i.update as Uint8Array).byteLength <= 300 * 1024),
      ).toBe(true);
      expect(
        items.reduce((n, i) => n + (i.update as Uint8Array).byteLength, 0),
      ).toBeGreaterThanOrEqual(400_000);

      const reloaded = await loaded(draft.id);
      expect(reloaded.getText('description').toString()).toBe(text);
      expect(Y.encodeStateVector(reloaded)).toEqual(
        Y.encodeStateVector(editor.doc),
      );
    }, 60_000);
  });

  // ----------------------------------------------------------------------------------- instance leaves

  describe('an instance leaves (graceful stop)', () => {
    let x: CatalogTestApp;
    let y: CatalogTestApp;
    let w: ShopWorld;
    const open: YClient[] = [];

    beforeAll(async () => {
      x = await instance('inst-x');
      y = await instance('inst-y');
    });
    afterAll(async () => {
      await x.close();
      await y.close();
    });

    it('S06 AS-47: a graceful stop leaves the ring first, flushes every pending update, then closes the sockets with 1012; clients reconnect to the new owner with no lost edit', async () => {
      await x.reset();
      x.clock.set(NOW);
      y.clock.set(NOW);
      w = await createShopWorld(x);
      await announceRing(x.app);
      await announceRing(y.app);
      await settleRing(x.app, y.app);

      const ids = idsFor(['inst-x', 'inst-y'], 3)['inst-x'];
      const editors: YClient[] = [];
      for (const id of ids) {
        await seedDraft(x.app, w.shop.id, w.owner.id, { id });
        const e = await openEditor(x, w.staff, w.shop.id, id);
        open.push(e);
        editors.push(e);
      }
      for (const e of editors) await e.whenSynced();
      expect(x.app.get(RoomManager).count()).toBe(3);
      editors.forEach((e, i) => e.doc.getText('title').insert(0, `edit-${i}`));

      let leftAt = 0;
      const ring = ringOf(x);
      const leave = ring.leave.bind(ring);
      jest.spyOn(ring, 'leave').mockImplementation(async () => {
        await leave();
        leftAt = Date.now();
      });
      const readyBefore = ring.registered();
      await x.app.get(ShutdownRegistry).run('drain');
      expect(readyBefore).toBe(true);
      expect(ring.registered()).toBe(false);
      await waitFor(async () => editors.every((e) => e.closed !== null), {
        description: 'sockets closed',
      });
      expect(editors.every((e) => e.closed!.code === 1012)).toBe(true);
      expect(editors.every((e) => e.closedAt >= leftAt && leftAt > 0)).toBe(
        true,
      ); // ring first, sockets last

      // Every edit reached the store before the sockets closed.
      for (const [i, id] of ids.entries())
        expect(
          (await storeOf(y).load(w.shop.id, id)).doc
            .getText('title')
            .toString(),
        ).toBe(`edit-${i}`);

      // Clients reconnect through connect and reach the new owner.
      await ringOf(y).refreshNow();
      for (const [i, e] of editors.entries()) {
        const again = await openEditor(y, w.staff, w.shop.id, ids[i], {
          doc: e.doc,
        });
        open.push(again);
        await again.whenSynced();
        expect(again.title()).toBe(`edit-${i}`);
      }
      jest.restoreAllMocks();
    }, 90_000);
  });

  describe('an instance crashes', () => {
    let x: CatalogTestApp;
    let y: CatalogTestApp;
    let w: ShopWorld;
    const open: YClient[] = [];

    beforeAll(async () => {
      x = await instance('inst-x');
      y = await instance('inst-y');
    });
    afterAll(async () => {
      jest.restoreAllMocks();
      await x.close();
      await y.close();
    });

    it("S06 AS-47: after 15 seconds without heartbeat the instance drops out of every ring; the edits of its last 100 ms that never reached storage come back from the clients' own copies when they sync", async () => {
      await x.reset();
      x.clock.set(NOW);
      y.clock.set(NOW);
      w = await createShopWorld(x);
      await announceRing(x.app);
      await announceRing(y.app);
      await settleRing(x.app, y.app);
      const draft = await seedDraft(x.app, w.shop.id, w.owner.id, {
        id: idsFor(['inst-x', 'inst-y'])['inst-x'][0],
      });
      const e1 = await openEditor(x, w.staff, w.shop.id, draft.id);
      const e2 = await openEditor(x, w.admin, w.shop.id, draft.id);
      open.push(e1, e2);
      await e1.whenSynced();
      await e2.whenSynced();
      e1.doc.getText('title').insert(0, 'persisted ');
      await waitFor(async () => (await logSeqs(x.app, draft.id)).length === 1);

      // The last moments before the crash: the update is broadcast but never reaches the store.
      jest
        .spyOn(storeOf(x), 'append')
        .mockImplementation(() => new Promise<number>(() => undefined));
      e1.doc.getText('title').insert(0, 'lost-on-crash ');
      await waitFor(async () => e2.title().includes('lost-on-crash'));

      // The process dies: sockets drop, the heartbeat stops, the ring entry is left to expire.
      const registry = ringOf(x) as unknown as { heartbeat?: NodeJS.Timeout };
      clearInterval(registry.heartbeat);
      jest.spyOn(ringOf(x), 'leave').mockResolvedValue(undefined);
      for (const ws of (
        x.app.get(CollabServer) as unknown as {
          wss: { clients: Set<{ terminate(): void }> };
        }
      ).wss.clients)
        ws.terminate();
      await waitFor(async () => e1.closed !== null && e2.closed !== null);

      y.clock.advance(16_000);
      await ringOf(y).heartbeatNow(); // the survivor keeps announcing itself; the dead one does not
      expect((await ringOf(y).members()).map((m) => m.id)).toEqual(['inst-y']);
      expect(
        (await storeOf(y).load(w.shop.id, draft.id)).doc
          .getText('title')
          .toString(),
      ).toBe('persisted ');

      // The clients reconnect (through the surviving instance) and exchange state: their copies restore the edit.
      const r1 = await openEditor(y, w.staff, w.shop.id, draft.id, {
        doc: e1.doc,
      });
      const r2 = await openEditor(y, w.admin, w.shop.id, draft.id, {
        doc: e2.doc,
      });
      open.push(r1, r2);
      await r1.whenSynced();
      await r2.whenSynced();
      await waitFor(
        async () => {
          const title = (await storeOf(y).load(w.shop.id, draft.id)).doc
            .getText('title')
            .toString();
          return title.includes('lost-on-crash') && title.includes('persisted');
        },
        { description: 'the lost edit is back in the store' },
      );
      expect(r1.title()).toBe(r2.title());

      // The crashed process is gone for good: drop the room that was stuck in its write.
      (
        x.app.get(RoomManager).roomOf(draft.id) as unknown as
          { evict(): void } | undefined
      )?.evict();
    }, 90_000);
  });
});
