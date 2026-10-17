import * as jwt from 'jsonwebtoken';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import { v7 as uuidv7 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { Role } from '@app/domains/identity';
import { ShopStatusChanged } from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { YClient } from '@app/test/fakes/y-client';
import { waitFor } from '@app/test/utils/async-helpers';
import { HashRing } from './domain/hash-ring';
import { CollabModule } from './collab.module';
import { DraftsModule } from './drafts.module';
import { DraftsProjectorModule } from './drafts-projector.module';
import { RoomManager } from './application/room-manager.service';
import { CollabServer } from './api/collab-server.service';
import {
  DraftMemberRemovedConsumer,
  DraftMemberRoleChangedConsumer,
  DraftShopOffboardingConsumer,
  DraftShopStatusConsumer,
} from './infra/drafts-consumers';
import {
  COLLAB_TIMINGS,
  DEFAULT_COLLAB_TIMINGS,
  type CollabTimings,
} from './domain/draft-limits';
import { DOC_STORE, type DocStore } from './domain/draft-ports';
import { readListing } from './domain/listing-doc';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import { createShopWorld, type ShopWorld } from './testing/catalog-spec-kit';
import {
  addUsers,
  announceRing,
  captureStdout,
  connectTo,
  draftRow,
  logSeqs,
  openEditor,
  seedDraft,
} from './testing/draft-spec-kit';

const NOW = new Date('2026-03-01T10:00:00.000Z');
const TIMINGS: CollabTimings = { ...DEFAULT_COLLAB_TIMINGS, idleUnloadMs: 300 };

const metric = (name: string, labels: Record<string, string> = {}) =>
  MetricsRegistry.value(name, labels) ?? 0;

describe('Collaborative editing rooms', () => {
  describe('on one editing instance', () => {
    let t: CatalogTestApp;
    let w: ShopWorld;
    let store: DocStore;
    let manager: RoomManager;
    let logs: ReturnType<typeof captureStdout>;
    const open: YClient[] = [];

    const base = () => `/api/shops/${w.shop.id}/drafts`;
    const editor = async (
      user: ShopWorld['owner'],
      draftId: string,
      options: ConstructorParameters<typeof YClient>[1] = {},
    ) => {
      const client = await openEditor(t, user, w.shop.id, draftId, options);
      open.push(client);
      return client;
    };
    const synced = async (...clients: YClient[]) => {
      for (const c of clients) await c.whenSynced();
    };
    const persisted = async (draftId: string) =>
      (await store.load(w.shop.id, draftId)).doc;

    beforeAll(async () => {
      // Before the app boots: the structured logger binds the stream it writes to when it is created.
      logs = captureStdout();
      t = await createCatalogApp({
        structuredLogger: true,
        extraImports: [DraftsModule, CollabModule, DraftsProjectorModule],
        overrides: [{ provide: COLLAB_TIMINGS, useValue: TIMINGS }],
      });
      store = t.app.get<DocStore>(DOC_STORE);
      manager = t.app.get(RoomManager);
    });
    afterAll(async () => {
      await t.close();
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
      // Only the spies a test made on the store and the manager; the stdout capture lives for the whole file.
      for (const spy of spies.splice(0)) spy.mockRestore();
    });
    const spies: jest.SpyInstance[] = [];
    const track = <T extends jest.SpyInstance>(spy: T): T => {
      spies.push(spy);
      return spy;
    };

    // ------------------------------------------------------------------------------------ US2: handshake

    it('S06 AS-12: a client that sends its first sync message at once, before the room is loaded, is accepted and synced; the server starts the exchange itself', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const original = store.load.bind(store);
      track(jest.spyOn(store, 'load')).mockImplementation(async (...args) => {
        await gate;
        return original(...args);
      });

      const client = await editor(w.staff, draft.id);
      await waitFor(async () => client.opened, { description: 'socket open' });
      // The client's step 1 is on the wire while the room is still loading: let the load finish only now.
      await new Promise((r) => setTimeout(r, 200));
      expect(client.framesReceived).toBe(0);
      release();

      await client.whenSynced();
      // The first frame is the server's own sync step 1 (type 0, sync step 1).
      expect(Array.from(client.received[0].slice(0, 2))).toEqual([0, 0]);
    });

    const KEY = () => t.app.get(ApiConfigService).get('collab_ticket_key')!;
    const claims = (draftId: string, extra: Record<string, unknown> = {}) => ({
      iss: 'marketplace-collab',
      aud: `collab:${draftId}`,
      sub: w.staff.id,
      shop: w.shop.id,
      draft: draftId,
      w: true,
      jti: uuidv7(),
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 60,
      ...extra,
    });
    const unsigned = (payload: Record<string, unknown>) =>
      `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.`;

    it('S06 AS-13: every bad ticket class is refused at the upgrade with 401, a bad Origin with 403, and no ticket text reaches a log', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const other = await seedDraft(t.app, w.shop.id, w.owner.id);
      const good = await connectTo(t, w.staff, w.shop.id, draft.id);
      const wsBase = good.url.replace(/\/collab\/.*/, '');
      const sign = (
        payload: object,
        key = KEY(),
        options: jwt.SignOptions = {},
      ) => jwt.sign(payload, key, { algorithm: 'HS256', ...options });
      const before = logs.length();

      const cases: [string, string | undefined][] = [
        ['a missing ticket', undefined],
        ['a malformed ticket', 'not-a-jwt'],
        [
          'an expired ticket (61 seconds old)',
          sign(
            claims(draft.id, {
              iat: NOW.getTime() / 1000 - 61,
              exp: NOW.getTime() / 1000 - 1,
            }),
          ),
        ],
        [
          'a ticket signed with another key',
          sign(claims(draft.id), 'another-key-of-a-different-secret-0123'),
        ],
        ['an unsigned (alg none) ticket', unsigned(claims(draft.id))],
        [
          'a ticket with the wrong issuer',
          sign(claims(draft.id, { iss: 'someone-else' })),
        ],
        [
          'a ticket with the wrong audience',
          sign(claims(draft.id, { aud: 'collab:other' })),
        ],
        ['a ticket issued for another draft', sign(claims(other.id))],
      ];
      for (const [name, ticket] of cases) {
        const url = `${wsBase}/collab/${draft.id}${ticket === undefined ? '' : `?ticket=${ticket}`}`;
        const client = new YClient(url);
        await waitFor(
          async () => client.refused !== null || client.closed !== null,
          {
            description: name,
          },
        );
        expect([name, client.refused]).toEqual([name, 401]);
      }

      // Used once: the first connection is accepted, the same ticket again is refused.
      const used = new YClient(`${good.url}?ticket=${good.ticket}`);
      open.push(used);
      await used.whenSynced();
      const replay = new YClient(`${good.url}?ticket=${good.ticket}`);
      await waitFor(async () => replay.refused !== null, {
        description: 'replay refused',
      });
      expect(replay.refused).toBe(401);

      // The origin is checked against the allowlist.
      const fresh = await connectTo(t, w.staff, w.shop.id, draft.id);
      const evil = new YClient(`${fresh.url}?ticket=${fresh.ticket}`, {
        headers: { Origin: 'https://evil.example' },
      });
      await waitFor(async () => evil.refused !== null, {
        description: 'origin refused',
      });
      expect(evil.refused).toBe(403);
      const allowed = new YClient(`${fresh.url}?ticket=${fresh.ticket}`, {
        headers: { Origin: 'http://localhost:3000' },
      });
      open.push(allowed);
      await allowed.whenSynced();

      // A valid ticket for a draft that is gone closes with 4004.
      const gone = uuidv7();
      const missing = new YClient(
        `${wsBase}/collab/${gone}?ticket=${sign(claims(gone))}`,
      );
      await waitFor(async () => missing.closed !== null, {
        description: 'draft gone',
      });
      expect(missing.closed!.code).toBe(4004);

      const written = logs.text(before);
      for (const [, ticket] of cases)
        if (ticket && ticket.length > 20) expect(written).not.toContain(ticket);
      expect(written).not.toContain(good.ticket);
      expect(written).not.toContain(fresh.ticket);
    });

    // --------------------------------------------------------------------------------- US2: convergence

    it('S06 AS-14: concurrent edits from two editors converge, and the state rebuilt from storage equals the live state', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const a = await editor(w.staff, draft.id);
      const b = await editor(w.admin, draft.id);
      await synced(a, b);

      a.doc.getText('title').insert(0, 'iPhone 17 Pro');
      b.doc.getText('title').insert(0, 'NEW: ');
      a.doc.getMap('fields').set('priceMinor', 129_900);
      b.doc.getMap('specs').set('Storage', '256 GB');

      await waitFor(
        async () =>
          a.title() === b.title() &&
          a.title().length === 'iPhone 17 Pro'.length + 'NEW: '.length &&
          b.doc.getMap('fields').get('priceMinor') === 129_900 &&
          a.doc.getMap('specs').get('Storage') === '256 GB',
        { description: 'convergence' },
      );
      expect(a.title()).toBe(b.title());
      expect(a.title()).toContain('iPhone 17 Pro');
      expect(a.title()).toContain('NEW: ');

      const rebuilt = await waitFor(async () => {
        const doc = await persisted(draft.id);
        return doc.getText('title').toString() === a.title() && doc;
      });
      expect(readListing(rebuilt as Y.Doc)).toMatchObject({
        priceMinor: 129_900,
        specs: { Storage: '256 GB' },
      });
    });

    it('S06 AS-15: the same update delivered twice changes nothing and persists nothing more', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const a = await editor(w.staff, draft.id);
      const b = await editor(w.admin, draft.id);
      await synced(a, b);

      const updates: Uint8Array[] = [];
      a.doc.on('update', (u: Uint8Array) => updates.push(u));
      a.doc.getText('title').insert(0, 'once');
      await waitFor(async () => b.title() === 'once');
      await waitFor(async () => (await logSeqs(t.app, draft.id)).length === 1);

      a.sendUpdate(updates[0]); // the network retry
      await new Promise((r) => setTimeout(r, 400));
      expect(a.title()).toBe('once');
      expect(b.title()).toBe('once');
      expect((await persisted(draft.id)).getText('title').toString()).toBe(
        'once',
      );
      expect(await logSeqs(t.app, draft.id)).toHaveLength(1);
    });

    it('S06 AS-16: an update that arrives before the one it depends on is held, then both apply and the result equals in-order delivery', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const sender = await editor(w.staff, draft.id);
      const watcher = await editor(w.admin, draft.id);
      await synced(sender, watcher);

      const author = new Y.Doc();
      const captured: Uint8Array[] = [];
      author.on('update', (u: Uint8Array) => captured.push(u));
      author.getText('title').insert(0, 'A');
      author.getText('title').insert(1, 'B'); // depends on the first
      const [a, b] = captured;

      sender.sendUpdate(b);
      await new Promise((r) => setTimeout(r, 300));
      expect(watcher.title()).toBe('');
      expect((await persisted(draft.id)).getText('title').toString()).toBe('');

      sender.sendUpdate(a);
      await waitFor(async () => watcher.title() === 'AB', {
        description: 'both applied',
      });
      const inOrder = new Y.Doc();
      Y.applyUpdate(inOrder, a);
      Y.applyUpdate(inOrder, b);
      expect(watcher.title()).toBe(inOrder.getText('title').toString());
      await waitFor(
        async () =>
          (await persisted(draft.id)).getText('title').toString() === 'AB',
      );
    });

    it('S06 AS-17: a client that was offline resumes with only what it lacks, its own edits are merged, and everything is identical', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const x = await editor(w.staff, draft.id);
      const y = await editor(w.admin, draft.id);
      await synced(x, y);
      y.doc.getText('description').insert(0, 'x'.repeat(20_000)); // a state much larger than the later edits
      await waitFor(async () => x.doc.getText('description').length === 20_000);

      const xDoc = x.doc;
      x.kill(); // the network drops
      await waitFor(async () => x.closed !== null);
      xDoc.getText('title').insert(0, 'a');
      xDoc.getText('title').insert(1, 'b');
      xDoc.getText('title').insert(2, 'c'); // three offline edits
      y.doc.getText('title').insert(0, 'Y!');
      y.doc.getMap('fields').set('brand', 'Acme');
      await waitFor(
        async () =>
          (await persisted(draft.id)).getMap('fields').get('brand') === 'Acme',
      );

      const resumed = await openEditor(t, w.staff, w.shop.id, draft.id, {
        doc: xDoc,
      });
      open.push(resumed);
      await resumed.whenSynced();
      await waitFor(
        async () => resumed.title() === y.title() && y.title().includes('abc'),
        { description: 'merged' },
      );
      expect(resumed.doc.getMap('fields').get('brand')).toBe('Acme');
      const full = Y.encodeStateAsUpdate(await persisted(draft.id)).byteLength;
      expect(full).toBeGreaterThan(20_000);
      expect(resumed.bytesReceived).toBeLessThan(full / 2); // only the missing part came down
      await waitFor(
        async () =>
          (await persisted(draft.id)).getText('title').toString() === y.title(),
      );
    });

    // ------------------------------------------------------------------------------------ presence

    it('S06 AS-18: cursors are relayed and never persisted, a late joiner sees them, a closed socket loses its cursor, silence expires one, and nobody can overwrite another presence entry', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const a = await editor(w.staff, draft.id);
      const b = await editor(w.admin, draft.id);
      await synced(a, b);
      const logBefore = await logSeqs(t.app, draft.id);

      a.awareness.setLocalState({ name: 'Ann', cursor: 3 });
      await waitFor(
        async () =>
          b.awareness.getStates().get(a.awareness.clientID)?.name === 'Ann',
      );
      a.awareness.setLocalState({ name: 'Ann', cursor: 9 });
      await waitFor(
        async () =>
          b.awareness.getStates().get(a.awareness.clientID)?.cursor === 9,
      );

      const late = await editor(w.owner, draft.id);
      await late.whenSynced();
      await waitFor(
        async () =>
          late.awareness.getStates().get(a.awareness.clientID)?.name === 'Ann',
        {
          description: 'late joiner sees the cursor',
        },
      );

      // b tries to speak for a's presence id: the frame is ignored.
      const forged = new awarenessProtocol.Awareness(new Y.Doc());
      forged.setLocalState({ name: 'HACKED' });
      const spoof = new awarenessProtocol.Awareness(new Y.Doc());
      (spoof as unknown as { clientID: number }).clientID =
        a.awareness.clientID;
      spoof.setLocalState({ name: 'HACKED', cursor: 0 });
      const frame = encoding.createEncoder();
      encoding.writeVarUint(frame, 1);
      encoding.writeVarUint8Array(
        frame,
        awarenessProtocol.encodeAwarenessUpdate(spoof, [a.awareness.clientID]),
      );
      b.sendRaw(encoding.toUint8Array(frame));
      await new Promise((r) => setTimeout(r, 300));
      expect(late.awareness.getStates().get(a.awareness.clientID)?.name).toBe(
        'Ann',
      );

      // A client that stops sending: its cursor expires after the silence period (the shared clock moves).
      t.clock.advance(31_000);
      manager.roomOf(draft.id)!.sweepPresence();
      await waitFor(
        async () => !late.awareness.getStates().has(a.awareness.clientID),
        {
          description: 'silent cursor removed',
        },
      );

      // A closing socket removes its cursor for everyone.
      b.awareness.setLocalState({ name: 'Bob' });
      await waitFor(
        async () =>
          late.awareness.getStates().get(b.awareness.clientID)?.name === 'Bob',
      );
      b.close();
      await waitFor(
        async () => !late.awareness.getStates().has(b.awareness.clientID),
        {
          timeoutMs: 1_000,
          intervalMs: 20,
          description: 'removed within a second',
        },
      );

      expect(await logSeqs(t.app, draft.id)).toEqual(logBefore); // presence never reached the log
      expect(
        (await draftRow<{ snapshotKey: string | null }>(t.app, draft.id))!
          .snapshotKey,
      ).toBeNull();
    });

    // ----------------------------------------------------------------------------------------- limits

    describe('limits (AS-19)', () => {
      const closedWith = async (client: YClient, code: number) => {
        await waitFor(async () => client.closed !== null, {
          description: `close ${code}`,
        });
        expect(client.closed!.code).toBe(code);
      };

      it('S06 AS-19: a frame over 512 KiB closes the connection with 1009 and nothing is applied', async () => {
        const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
        const a = await editor(w.staff, draft.id);
        const b = await editor(w.admin, draft.id);
        await synced(a, b);
        a.sendRaw(new Uint8Array(600 * 1024));
        await closedWith(a, 1009);
        expect(b.closed).toBeNull();
        expect(b.title()).toBe('');
      });

      it('S06 AS-19: a presence frame over 8 KiB closes the connection with 1009', async () => {
        const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
        const a = await editor(w.staff, draft.id);
        await synced(a);
        a.awareness.setLocalState({ name: 'x'.repeat(9 * 1024) });
        await closedWith(a, 1009);
      });

      it('S06 AS-19: a frame that cannot be decoded closes with 4000 and the room is unchanged', async () => {
        const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
        const a = await editor(w.staff, draft.id);
        const b = await editor(w.admin, draft.id);
        await synced(a, b);
        a.sendRaw(new Uint8Array([9, 9, 9]));
        await closedWith(a, 4000);
        expect(b.closed).toBeNull();
        expect(b.doc.getText('title').length).toBe(0);
      });

      it('S06 AS-19: an update that would take the document over 2 MiB is not applied or persisted and closes with 4009', async () => {
        const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
        const a = await editor(w.staff, draft.id);
        const b = await editor(w.admin, draft.id);
        await synced(a, b);
        const chunk = 'z'.repeat(450_000);
        for (let i = 0; i < 4; i++) {
          a.doc
            .getText('description')
            .insert(a.doc.getText('description').length, chunk);
          await waitFor(
            async () =>
              b.doc.getText('description').length === (i + 1) * 450_000,
          );
        }
        a.doc
          .getText('description')
          .insert(a.doc.getText('description').length, chunk);
        await closedWith(a, 4009);
        await new Promise((r) => setTimeout(r, 300));
        expect(b.doc.getText('description').length).toBe(4 * 450_000);
        await waitFor(
          async () =>
            (await persisted(draft.id)).getText('description').length ===
            4 * 450_000,
        );
      });

      it('S06 AS-19: more than 200 frames in a second close the connection with 4029', async () => {
        const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
        const a = await editor(w.staff, draft.id);
        await synced(a);
        for (let i = 0; i < 260; i++) a.sendRaw(new Uint8Array([3]));
        await closedWith(a, 4029);
      });

      it("S06 AS-19: the 51st connection to a room closes with 4008 room_full and the first 50 are unaffected; a user's 6th closes with 4008 too_many_connections", async () => {
        const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
        const users = await addUsers(t, w.shop.id, 11);
        const clients: YClient[] = [];
        for (const user of users.slice(0, 10))
          for (let i = 0; i < 5; i++)
            clients.push(await editor(user, draft.id));
        await synced(...clients);
        expect(clients).toHaveLength(50);

        const extra = await editor(users[10], draft.id);
        await closedWith(extra, 4008);
        expect(extra.closed!.reason).toBe('room_full');
        expect(clients.every((c) => c.closed === null)).toBe(true);

        clients[0].close();
        await waitFor(async () => clients[0].closed !== null);
        const sixth = await editor(users[1], draft.id); // users[1] still has 5 open
        await closedWith(sixth, 4008);
        expect(sixth.closed!.reason).toBe('too_many_connections');
      }, 120_000);
    });

    it('S06 AS-20: a client that stops answering pings is terminated after one missed round; the member and cursor are removed and the room keeps working', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const live = await editor(w.staff, draft.id);
      const sleeper = await editor(w.admin, draft.id, { silent: true });
      await synced(live, sleeper);
      sleeper.awareness.setLocalState({ name: 'Zed' });
      await waitFor(
        async () =>
          live.awareness.getStates().get(sleeper.awareness.clientID)?.name ===
          'Zed',
      );

      const server = t.app.get(CollabServer);
      server.pingSweep(); // marks every connection and pings it
      await waitFor(async () => manager.roomOf(draft.id) !== undefined);
      await new Promise((r) => setTimeout(r, 300)); // live answers, the sleeper does not
      server.pingSweep(); // the missed answer ends the sleeper

      await waitFor(async () => sleeper.closed !== null, {
        description: 'sleeper terminated',
      });
      await waitFor(
        async () => !live.awareness.getStates().has(sleeper.awareness.clientID),
      );
      expect(manager.roomOf(draft.id)!.connections).toBe(1);
      expect(live.closed).toBeNull();
      live.doc.getText('title').insert(0, 'still works');
      await waitFor(
        async () =>
          (await persisted(draft.id)).getText('title').toString() ===
          'still works',
      );
    });

    it('S06 AS-21: 50 editors opening a cold draft load it once; the last leaving unloads it after the idle period (flush, compact); a join during the unload waits and sees every edit', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const users = await addUsers(t, w.shop.id, 10);
      const load = track(jest.spyOn(store, 'load'));
      const clients = await Promise.all(
        Array.from({ length: 50 }, (_, i) => editor(users[i % 10], draft.id)),
      );
      await synced(...clients);
      expect(load).toHaveBeenCalledTimes(1);

      clients[0].doc.getText('title').insert(0, 'before unload');
      await waitFor(async () => clients[49].title() === 'before unload');

      // Hold the compaction so the unload is in progress while someone joins.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const compact = store.compact.bind(store);
      const compacting = track(jest.spyOn(store, 'compact')).mockImplementation(
        async (...args) => {
          await gate;
          return compact(...args);
        },
      );
      const conflicts = metric('collab_sequence_conflicts_total');
      clients.forEach((c) => c.close());
      await waitFor(async () => compacting.mock.calls.length > 0, {
        description: 'the unload started compacting',
      });

      const joiner = await editor(w.staff, draft.id);
      await new Promise((r) => setTimeout(r, 300));
      expect(joiner.synced).toBe(false); // waiting for the unload
      release();
      await joiner.whenSynced();
      expect(joiner.title()).toBe('before unload');
      expect(load).toHaveBeenCalledTimes(2);

      joiner.doc.getText('title').insert(0, '>> ');
      await waitFor(
        async () =>
          (await persisted(draft.id)).getText('title').toString() ===
          '>> before unload',
      );
      expect(metric('collab_sequence_conflicts_total')).toBe(conflicts);

      // The idle unload: pending flushed and compacted, the log trimmed up to the snapshot, the room gone.
      joiner.close();
      await waitFor(async () => manager.count() === 0, {
        description: 'room unloaded',
      });
      const row = await draftRow<{ snapshotSeq: string }>(t.app, draft.id);
      expect(Number(row!.snapshotSeq)).toBeGreaterThan(0);
      expect(
        (await logSeqs(t.app, draft.id)).filter(
          (s) => s <= Number(row!.snapshotSeq),
        ),
      ).toEqual([]);
    }, 120_000);

    // ------------------------------------------------------------------ US3: abilities and revocation

    it("S06 AS-22: a read-only member's update and state frames are dropped with a read_only message, nothing is broadcast or persisted, the socket stays open and a log line names the ids without content", async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const writer = await editor(w.staff, draft.id);
      const reader = await editor(w.viewer, draft.id);
      await synced(writer, reader);
      const denied = metric('collab_denied_writes_total', {
        reason: 'read_only',
      });
      const before = logs.length();

      expect(reader.denied).toEqual([]); // the empty step 2 of the handshake is not a write
      reader.doc.getText('title').insert(0, 'HACKED SECRET');
      await waitFor(async () => reader.denied.length === 1, {
        description: 'denied message',
      });
      expect(reader.denied).toEqual(['read_only']);
      const stateOnly = new Y.Doc();
      stateOnly.getText('title').insert(0, 'FORGED');
      reader.sendStep2(Y.encodeStateAsUpdate(stateOnly));
      await waitFor(async () => reader.denied.length === 2, {
        timeoutMs: 3_000,
        description: `second denial (closed=${JSON.stringify(reader.closed)} denied=${reader.denied.length})`,
      });

      await new Promise((r) => setTimeout(r, 300));
      expect(writer.title()).toBe('');
      expect((await persisted(draft.id)).getText('title').toString()).toBe('');
      expect(reader.closed).toBeNull();
      expect(
        metric('collab_denied_writes_total', { reason: 'read_only' }),
      ).toBe(denied + 2);

      // It still receives everyone's edits and can send presence.
      writer.doc.getText('title').insert(0, 'Official');
      await waitFor(async () => reader.title().includes('Official'));
      reader.awareness.setLocalState({ name: 'Viewer' });
      await waitFor(
        async () =>
          writer.awareness.getStates().get(reader.awareness.clientID)?.name ===
          'Viewer',
      );

      const line = await waitFor(
        async () =>
          logs
            .lines(before)
            .find((l) => JSON.stringify(l).includes('write_denied')),
        {
          timeoutMs: 3_000,
          intervalMs: 50,
          description: 'the structured log line',
        },
      );
      expect(JSON.stringify(line)).toContain(draft.id);
      expect(JSON.stringify(line)).toContain(w.shop.id);
      expect(JSON.stringify(line)).toContain(w.viewer.id);
      expect(logs.text(before)).not.toContain('HACKED SECRET');
      expect(logs.text(before)).not.toContain('FORGED');
    });

    const role = async (userId: string, to: 'VIEWER' | 'STAFF') =>
      t
        .as(w.owner)
        .patch(`/api/shops/${w.shop.id}/members/${userId}`)
        .send({ role: to })
        .expect(204);

    /** Delivers the newest event of that type that the tenancy routes wrote to the outbox to a real consumer. */
    const deliver = async (
      consumer: { project(events: EventEnvelope[]): Promise<unknown> },
      type: string,
    ) => {
      const [row] = await t.app
        .get(Sequelize)
        .query<{ payload: EventEnvelope }>(
          `SELECT "payload" FROM "Outbox" WHERE "type" = :type AND "kind" = 'event' ORDER BY "id" DESC LIMIT 1`,
          { type: QueryTypes.SELECT, replacements: { type } },
        );
      await consumer.project([row.payload]);
    };

    it('S06 AS-23: a role change to viewer, delivered through the real consumer, makes further updates denied within seconds; earlier edits stay; a role that adds write takes effect on the next connect', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const demoted = await editor(w.staff, draft.id);
      const other = await editor(w.admin, draft.id);
      await synced(demoted, other);
      demoted.doc.getText('title').insert(0, 'early');
      await waitFor(async () => other.title() === 'early');

      await role(w.staff.id, 'VIEWER');
      await deliver(
        t.app.get(DraftMemberRoleChangedConsumer),
        'tenancy.member_role_changed',
      );
      // Updates sent from now on are refused within seconds; the ones that got in before the notice stay.
      await waitFor(
        async () => {
          demoted.doc.getText('title').insert(0, '!');
          await new Promise((r) => setTimeout(r, 100));
          return demoted.denied.length > 0;
        },
        { timeoutMs: 5_000, description: 'writes denied' },
      );
      expect(demoted.closed).toBeNull();
      demoted.doc.getText('title').insert(0, 'LATE');
      await new Promise((r) => setTimeout(r, 400));
      expect(other.title()).toContain('early');
      expect(other.title()).not.toContain('LATE');
      const stored = (await persisted(draft.id)).getText('title').toString();
      expect(stored).toContain('early');
      expect(stored).not.toContain('LATE');

      // Gaining write: the connected viewer stays read-only, the next connect is a writer.
      const viewer = await editor(w.viewer, draft.id);
      await synced(viewer);
      await role(w.viewer.id, 'STAFF');
      await deliver(
        t.app.get(DraftMemberRoleChangedConsumer),
        'tenancy.member_role_changed',
      );
      await new Promise((r) => setTimeout(r, 500));
      viewer.doc.getText('description').insert(0, 'still read only');
      await waitFor(async () => viewer.denied.length > 0);
      expect((await connectTo(t, w.viewer, w.shop.id, draft.id)).canWrite).toBe(
        true,
      );
    });

    it("S06 AS-24: a removed member's sockets close with 4003 within seconds, others are unaffected, their edits remain, and their next connect is 404 shop_not_found", async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const draft2 = await seedDraft(t.app, w.shop.id, w.owner.id);
      const removed1 = await editor(w.staff, draft.id);
      const removed2 = await editor(w.staff, draft2.id);
      const stays = await editor(w.admin, draft.id);
      await synced(removed1, removed2, stays);
      removed1.doc.getText('title').insert(0, 'kept');
      await waitFor(async () => stays.title() === 'kept');

      await t
        .as(w.owner)
        .delete(`/api/shops/${w.shop.id}/members/${w.staff.id}`)
        .expect(204);
      await deliver(
        t.app.get(DraftMemberRemovedConsumer),
        'tenancy.member_removed',
      );
      await waitFor(
        async () => removed1.closed !== null && removed2.closed !== null,
        {
          timeoutMs: 5_000,
          description: 'both sockets closed',
        },
      );
      expect(removed1.closed!.code).toBe(4003);
      expect(removed2.closed!.code).toBe(4003);
      expect(removed1.closed!.reason).toBe('access_revoked');
      expect(stays.closed).toBeNull();
      expect((await persisted(draft.id)).getText('title').toString()).toBe(
        'kept',
      );
      await t.as(w.staff).post(`${base()}/${draft.id}/connect`).expect(404);
    });

    it('S06 AS-24: with the instant notification lost, the periodic membership re-check (one batched read per shop) closes the socket', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const removed = await editor(w.staff, draft.id);
      const stays = await editor(w.admin, draft.id);
      await synced(removed, stays);

      await t
        .as(w.owner)
        .delete(`/api/shops/${w.shop.id}/members/${w.staff.id}`)
        .expect(204);
      // No notification arrives: the consumer is never called. The room keeps the socket until it asks again.
      await new Promise((r) => setTimeout(r, 300));
      expect(removed.closed).toBeNull();

      const members = track(
        jest.spyOn(
          (
            manager as unknown as {
              membership: { accessOfMany: (...a: unknown[]) => unknown };
            }
          ).membership,
          'accessOfMany',
        ),
      );
      await manager.recheckAll();
      await waitFor(async () => removed.closed !== null, {
        description: 're-check closed it',
      });
      expect(removed.closed!.code).toBe(4003);
      expect(stays.closed).toBeNull();
      expect(members).toHaveBeenCalledTimes(1); // one read for the whole shop
    });

    it('S06 AS-25: a suspended shop closes its rooms with 4003 shop_inactive and blocks connects; when it is active again connects work', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const a = await editor(w.staff, draft.id);
      const b = await editor(w.admin, draft.id);
      await synced(a, b);
      a.doc.getText('title').insert(0, 'flushed on close');
      await waitFor(async () => b.title() === 'flushed on close');

      const platformAdmin = await t.newUser({ role: Role.ADMIN });
      await t
        .as(platformAdmin)
        .post(`/api/admin/shops/${w.shop.id}/suspend`)
        .send({ reason: 'policy' })
        .expect(200);
      await deliver(
        t.app.get(DraftShopStatusConsumer),
        'tenancy.shop_status_changed',
      );
      await waitFor(async () => a.closed !== null && b.closed !== null, {
        timeoutMs: 5_000,
      });
      expect(a.closed).toEqual({ code: 4003, reason: 'shop_inactive' });
      expect((await persisted(draft.id)).getText('title').toString()).toBe(
        'flushed on close',
      );
      const refused = await t
        .as(w.staff)
        .post(`${base()}/${draft.id}/connect`)
        .expect(403);
      expect(refused.body.code).toBe('shop_suspended');

      await t
        .as(platformAdmin)
        .post(`/api/admin/shops/${w.shop.id}/reinstate`)
        .send({ reason: 'resolved' })
        .expect(200);
      await deliver(
        t.app.get(DraftShopStatusConsumer),
        'tenancy.shop_status_changed',
      );
      // Active again: connects work and nothing closes.
      const again = await connectTo(t, w.staff, w.shop.id, draft.id);
      expect(again.canWrite).toBe(true);
      const back = await editor(w.staff, draft.id);
      await synced(back);
      expect(back.closed).toBeNull();
    });

    it('S06 AS-25: a shop entering offboarding closes its rooms with 4003 shop_inactive and connects answer 409 shop_offboarding', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const a = await editor(w.staff, draft.id);
      await synced(a);
      await t
        .as(w.owner)
        .post(`/api/shops/${w.shop.id}/offboarding`)
        .send({ confirmSlug: (w.shop as unknown as { slug: string }).slug })
        .expect(200);
      await deliver(
        t.app.get(DraftShopOffboardingConsumer),
        'tenancy.shop_offboarding_started',
      );
      await waitFor(async () => a.closed !== null, { timeoutMs: 5_000 });
      expect(a.closed).toEqual({ code: 4003, reason: 'shop_inactive' });
      const refused = await t
        .as(w.staff)
        .post(`${base()}/${draft.id}/connect`)
        .expect(409);
      expect(refused.body.code).toBe('shop_offboarding');
    });

    it('S06 AS-26: a status event about a shop that is active again closes nothing (events are triggers, the shop as it is now decides)', async () => {
      const draft = await seedDraft(t.app, w.shop.id, w.owner.id);
      const a = await editor(w.staff, draft.id);
      await synced(a);
      await t.app.get(DraftShopStatusConsumer).project([
        ShopStatusChanged.create(w.shop.id, 1, {
          shopId: w.shop.id,
          from: 'ACTIVE',
          to: 'SUSPENDED',
          shopVersion: 1,
        }),
      ]);
      await new Promise((r) => setTimeout(r, 500));
      expect(a.closed).toBeNull();
    });
  });

  describe('on two editing instances', () => {
    let proxy: TcpFaultProxy;
    let a: CatalogTestApp; // reaches Redis through the fault proxy
    let b: CatalogTestApp;
    let w: ShopWorld;
    let logs: ReturnType<typeof captureStdout>;
    const open: YClient[] = [];
    const modules = [DraftsModule, CollabModule, DraftsProjectorModule];

    /** Draft ids that the ring of the two instances gives to `inst-a` and to `inst-b`. */
    const idsFor = () => {
      const ring = new HashRing(['inst-a', 'inst-b']);
      const ids: Record<string, string> = {};
      while (!ids['inst-a'] || !ids['inst-b']) {
        const id = uuidv7();
        ids[ring.nodeFor(id)!] ??= id;
      }
      return ids;
    };

    beforeAll(async () => {
      logs = captureStdout();
      const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
      proxy = await TcpFaultProxy.start({
        host: url.hostname,
        port: Number(url.port || 6379),
      });
      b = await createCatalogApp({
        extraImports: modules,
        env: { COLLAB_INSTANCE_ID: 'inst-b' },
      });
      a = await createCatalogApp({
        extraImports: modules,
        env: { COLLAB_INSTANCE_ID: 'inst-a' },
        redisUrl: `redis://127.0.0.1:${proxy.port}/0`,
      });
    });
    afterAll(async () => {
      proxy.mode = 'pass';
      await a.close();
      await b.close();
      await proxy.close();
      logs.restore();
    });
    beforeEach(async () => {
      proxy.mode = 'pass';
      await a.reset();
      a.clock.set(NOW);
      b.clock.set(NOW);
      w = await createShopWorld(a);
      await announceRing(a.app);
      await announceRing(b.app);
    });
    afterEach(() => open.splice(0).forEach((c) => c.close()));

    const setup = async () => {
      const ids = idsFor();
      const d1 = await seedDraft(a.app, w.shop.id, w.owner.id, {
        id: ids['inst-a'],
      });
      const d2 = await seedDraft(a.app, w.shop.id, w.owner.id, {
        id: ids['inst-b'],
      });
      const c1 = await connectTo(a, w.staff, w.shop.id, d1.id);
      const c2 = await connectTo(a, w.staff, w.shop.id, d2.id);
      const e1 = new YClient(`${c1.url}?ticket=${c1.ticket}`);
      const e2 = new YClient(`${c2.url}?ticket=${c2.ticket}`);
      open.push(e1, e2);
      await e1.whenSynced();
      await e2.whenSynced();
      expect(c1.url).not.toBe(c2.url); // the two rooms really live on different instances
      return { e1, e2 };
    };

    /** The owner removes the member through the healthy instance; the consumer that tells the rooms runs on `a`. */
    const deliverRemoval = async () => {
      await b
        .as(w.owner)
        .delete(`/api/shops/${w.shop.id}/members/${w.staff.id}`)
        .expect(204);
      const [row] = await a.app
        .get(Sequelize)
        .query<{ payload: EventEnvelope }>(
          `SELECT "payload" FROM "Outbox" WHERE "type" = 'tenancy.member_removed' AND "kind" = 'event' ORDER BY "id" DESC LIMIT 1`,
          { type: QueryTypes.SELECT },
        );
      await a.app.get(DraftMemberRemovedConsumer).project([row.payload]);
    };

    it('S06 AS-24: a member removed from the shop loses the sockets of rooms on two different instances within seconds; the other members are unaffected', async () => {
      const { e1, e2 } = await setup();
      const ids = idsFor();
      const stays = await seedDraft(a.app, w.shop.id, w.owner.id, {
        id: ids['inst-b'],
      });
      const cs = await connectTo(a, w.admin, w.shop.id, stays.id);
      const keeper = new YClient(`${cs.url}?ticket=${cs.ticket}`);
      open.push(keeper);
      await keeper.whenSynced();

      await deliverRemoval();
      await waitFor(async () => e1.closed !== null && e2.closed !== null, {
        timeoutMs: 5_000,
        description: 'both sockets closed',
      });
      expect(e1.closed!.code).toBe(4003);
      expect(e2.closed!.code).toBe(4003);
      expect(keeper.closed).toBeNull();
    });

    it('S06 AS-24: when the instant notification between the processes is lost, the periodic re-check of each instance closes the sockets', async () => {
      const { e1, e2 } = await setup();
      // The consumer's process cannot reach the channel: its publish is dropped (best effort), nobody is told.
      proxy.mode = 'refuse';
      proxy.sever();
      await waitFor(
        async () => a.app.get(RedisService).client.status !== 'ready',
        {
          timeoutMs: 5_000,
          intervalMs: 10,
          description: 'the client noticed the cut',
        },
      );
      await deliverRemoval();
      await new Promise((r) => setTimeout(r, 500));
      expect(e1.closed).toBeNull();
      expect(e2.closed).toBeNull();

      // The re-check of 60 seconds, run now on each instance: one batched membership read per shop.
      await a.app.get(RoomManager).recheckAll();
      await b.app.get(RoomManager).recheckAll();
      await waitFor(async () => e1.closed !== null && e2.closed !== null, {
        timeoutMs: 5_000,
        description: 're-check closed both',
      });
      expect(e1.closed!.code).toBe(4003);
      expect(e2.closed!.code).toBe(4003);
    });
  });
});
