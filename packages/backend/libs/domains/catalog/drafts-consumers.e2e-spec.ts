import { Injectable, type INestApplication, type Type } from '@nestjs/common';
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import * as Y from 'yjs';
import {
  MemberRemoved,
  MemberRoleChanged,
  ShopDeleted,
  ShopOffboardingStarted,
  ShopStatusChanged,
} from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { ConsumerKit } from '@app/infrastructure/events/testing/consumer-kit';
import type { Projector } from '@app/infrastructure/projections/projector';
import { createShop } from '@app/test/utils/tenancy-fixtures';
import { readTopic } from '@app/test/utils/kafka-test';
import { waitFor } from '@app/test/utils/async-helpers';
import { parseBackplaneMessage } from './domain/backplane-message';
import {
  DOC_STORE,
  DRAFT_REPOSITORY,
  SNAPSHOT_STORE,
  type BackplaneMessage,
  type DocStore,
  type DraftRepository,
  type SnapshotStore,
} from './domain/draft-ports';
import { DraftsModule } from './drafts.module';
import { CollabModule } from './collab.module';
import { DraftsProjectorModule } from './drafts-projector.module';
import { COLLAB_REVOKE_CHANNEL } from './infra/collab-backplane';
import {
  DraftMemberRemovedConsumer,
  DraftMemberRoleChangedConsumer,
  DraftShopDeletedConsumer,
  DraftShopOffboardingConsumer,
  DraftShopStatusConsumer,
} from './infra/drafts-consumers';
import { createCatalogApp, type CatalogTestApp } from './testing/catalog-app';
import { createShopWorld, type ShopWorld } from './testing/catalog-spec-kit';
import {
  announceRing,
  draftCount,
  logSeqs,
  openEditor,
  seedDraft,
  seedDrafts,
  seedVersion,
  versionRows,
} from './testing/draft-spec-kit';

/** Listens to the backplane channel the way an editing instance does. */
async function listen() {
  const messages: BackplaneMessage[] = [];
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
  redis.on('error', () => undefined);
  redis.on('message', (_channel, raw) => {
    const message = parseBackplaneMessage(raw);
    if (message) messages.push(message);
  });
  await redis.subscribe(COLLAB_REVOKE_CHANNEL);
  return { messages, stop: () => redis.disconnect() };
}

describe('Draft tenancy event consumers', () => {
  const kit = new ConsumerKit();
  beforeAll(() => kit.start());
  afterAll(() => kit.stopAll());

  /** The consumer on a topic and group of its own, running through the event stream with the real framework. */
  async function stream(
    Base: Type<Projector>,
    baseName: string,
  ): Promise<{
    s: Awaited<ReturnType<ConsumerKit['scenario']>>;
    app: INestApplication;
    name: string;
  }> {
    const s = await kit.scenario();
    const name = `${baseName}-${s.id}`;
    @Injectable()
    class Streamed extends (Base as Type<{ name: string; topics: string[] }>) {
      readonly name: string = name;
      readonly topics: string[] = [s.topic];
    }
    const app = await s.boot([Streamed as unknown as Type<Projector>], {
      imports: [DraftsProjectorModule],
    });
    return { s, app, name };
  }

  const raw = (e: EventEnvelope, patch: Partial<EventEnvelope> = {}) => ({
    key: e.aggregateId,
    value: JSON.stringify({ ...e, ...patch }),
  });
  const unique = () => ({ shopId: uuidv7(), userId: uuidv7() });

  it('S06 AS-26: member removed: a duplicate delivery gives one notification, an invalid payload is dead-lettered with no effect, and the next valid event is processed', async () => {
    const { s, name } = await stream(
      DraftMemberRemovedConsumer,
      'catalog-drafts-member-removed',
    );
    const bus = await listen();
    try {
      const first = unique();
      const second = unique();
      const ok = (ids: { shopId: string; userId: string }) =>
        MemberRemoved.create(ids.shopId, 1, {
          ...ids,
          role: 'STAFF',
          reason: 'removed',
        });
      const event = ok(first);
      const bad = [
        {
          ...ok(unique()),
          payload: {
            shopId: 'nope',
            userId: uuidv7(),
            role: 'STAFF',
            reason: 'removed',
          },
        },
        {
          ...ok(unique()),
          payload: { shopId: uuidv7(), role: 'STAFF', reason: 'removed' },
        },
        {
          ...ok(unique()),
          payload: {
            shopId: uuidv7(),
            userId: uuidv7(),
            role: 'GOD',
            reason: 'removed',
          },
        },
      ];
      await s.publishRaw([
        raw(event),
        raw(event),
        ...bad.map((b) => raw(b as EventEnvelope)),
        raw(ok(second)),
      ]);

      await waitFor(
        async () =>
          bus.messages.some(
            (m) => m.type === 'revoke' && m.userId === second.userId,
          ),
        { description: 'the later event processed' },
      );
      await waitFor(async () => (await readTopic(`${name}.dlq`)).length === 3, {
        description: '3 dead letters',
      });
      const revokes = bus.messages.filter((m) => m.type === 'revoke');
      expect(revokes.filter((m) => m.userId === first.userId)).toHaveLength(1);
      expect(revokes).toHaveLength(2); // the bad ones made no notification
    } finally {
      bus.stop();
    }
  });

  it('S06 AS-26: role changed: a duplicate gives one notification, an unknown role is dead-lettered', async () => {
    const { s, name } = await stream(
      DraftMemberRoleChangedConsumer,
      'catalog-drafts-member-role-changed',
    );
    const bus = await listen();
    try {
      const ids = unique();
      const good = MemberRoleChanged.create(ids.shopId, 2, {
        ...ids,
        from: 'STAFF',
        to: 'VIEWER',
      });
      const later = unique();
      const bad = {
        ...MemberRoleChanged.create(uuidv7(), 2, {
          ...unique(),
          from: 'STAFF',
          to: 'VIEWER',
        }),
        payload: { ...unique(), from: 'STAFF', to: 'WIZARD' },
      };
      await s.publishRaw([
        raw(good),
        raw(good),
        raw(bad as EventEnvelope),
        raw(
          MemberRoleChanged.create(later.shopId, 2, {
            ...later,
            from: 'VIEWER',
            to: 'STAFF',
          }),
        ),
      ]);
      await waitFor(
        async () =>
          (await readTopic(`${name}.dlq`)).length === 1 &&
          bus.messages.some(
            (m) => m.type === 'recheck' && m.userId === later.userId,
          ),
        { description: 'the dead letter and the later event' },
      );
      expect(
        bus.messages.filter(
          (m) => m.type === 'recheck' && m.userId === ids.userId,
        ),
      ).toHaveLength(1);
    } finally {
      bus.stop();
    }
  });

  /**
   * The two consumers that close a shop's rooms look at the shop as it is now: a notification about a shop that is
   * `ACTIVE` (a stale event that a newer one already undid) closes nothing.
   */
  describe.each([
    {
      title: 'shop status changed',
      Base: DraftShopStatusConsumer,
      baseName: 'catalog-drafts-shop-status',
      event: (shopId: string) =>
        ShopStatusChanged.create(shopId, 2, {
          shopId,
          from: 'ACTIVE',
          to: 'SUSPENDED',
          shopVersion: 2,
        }),
      invalid: (e: EventEnvelope) => ({
        ...e,
        payload: {
          shopId: (e.payload as { shopId: string }).shopId,
          from: 'ACTIVE',
          to: 'SUSPENDED',
          shopVersion: 'x',
        },
      }),
      close: 'SUSPENDED' as const,
    },
    {
      title: 'shop offboarding started',
      Base: DraftShopOffboardingConsumer,
      baseName: 'catalog-drafts-shop-offboarding',
      event: (shopId: string) =>
        ShopOffboardingStarted.create(shopId, 2, {
          shopId,
          purgeAt: '2026-11-01T00:00:00.000Z',
          shopVersion: 2,
        }),
      invalid: (e: EventEnvelope) => ({
        ...e,
        payload: { purgeAt: 'x', shopVersion: 2 },
      }),
      close: 'DELETING' as const,
    },
  ])('$title', ({ Base, baseName, event, invalid, close }) => {
    it('S06 AS-26: a duplicate gives one close, an invalid payload is dead-lettered, and a stale event about an active shop closes nothing', async () => {
      const { s, app, name } = await stream(Base, baseName);
      const closing = await createShop(app, null, { status: close });
      const active = await createShop(app, null, { status: 'ACTIVE' });
      const later = await createShop(app, null, { status: close });
      const bus = await listen();
      try {
        const good = event(closing.id);
        await s.publishRaw([
          raw(good),
          raw(good),
          raw(invalid(event(uuidv7()))),
          raw(event(active.id)), // stale: the shop is active again
          raw(event(later.id)),
        ]);
        await waitFor(
          async () =>
            (await readTopic(`${name}.dlq`)).length === 1 &&
            bus.messages.some(
              (m) => m.type === 'close-shop' && m.shopId === later.id,
            ),
          { description: 'the dead letter and the later event' },
        );
        await new Promise((r) => setTimeout(r, 300));
        const closes = bus.messages.filter((m) => m.type === 'close-shop');
        expect(closes.filter((m) => m.shopId === closing.id)).toHaveLength(1);
        expect(closes.filter((m) => m.shopId === active.id)).toHaveLength(0);
      } finally {
        bus.stop();
      }
    });
  });

  it('S06 AS-26: a shop deleted event with an invalid payload is dead-lettered with no purge, and a duplicate purges once', async () => {
    const { s, app, name } = await stream(
      DraftShopDeletedConsumer,
      'catalog-drafts-shop-deleted',
    );
    const owner = null;
    const shop = await createShop(app, owner);
    const keep = await createShop(app, owner);
    await seedDrafts(app, shop.id, uuidv7(), 3);
    await seedDrafts(app, keep.id, uuidv7(), 2);
    const good = ShopDeleted.create(shop.id, 5, {
      shopId: shop.id,
      shopVersion: 5,
    });
    const bad = {
      ...ShopDeleted.create(keep.id, 5, { shopId: keep.id, shopVersion: 5 }),
      payload: { shopVersion: 5 },
    };
    await s.publishRaw([raw(good), raw(good), raw(bad as EventEnvelope)]);
    await waitFor(
      async () =>
        (await readTopic(`${name}.dlq`)).length === 1 &&
        (await draftCount(app, `"shopId" = :s`, { s: shop.id })) === 0,
      { description: 'the shop purged and the bad event dead-lettered' },
    );
    expect(await draftCount(app, `"shopId" = :s`, { s: keep.id })).toBe(2);
  });
});

describe('Draft tenancy event consumers: shop deleted', () => {
  let t: CatalogTestApp;
  let w: ShopWorld;
  let drafts: DraftRepository;
  let docs: DocStore;
  let objects: SnapshotStore;

  beforeAll(async () => {
    t = await createCatalogApp({
      extraImports: [DraftsModule, CollabModule, DraftsProjectorModule],
    });
    drafts = t.app.get<DraftRepository>(DRAFT_REPOSITORY, { strict: false });
    docs = t.app.get<DocStore>(DOC_STORE, { strict: false });
    objects = t.app.get<SnapshotStore>(SNAPSHOT_STORE, { strict: false });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await createShopWorld(t);
    await announceRing(t.app);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A draft with a stored snapshot, log entries and a version object. */
  const fullDraft = async (shopId: string) => {
    const draft = await seedDraft(t.app, shopId, w.owner.id);
    const doc = new Y.Doc();
    doc.getText('title').insert(0, 'stored');
    await docs.append(draft.id, 1, Y.encodeStateAsUpdate(doc));
    const state = new Y.Doc();
    Y.applyUpdate(state, Y.encodeStateAsUpdate(doc));
    await docs.compact(shopId, draft.id, state, 1);
    await docs.append(draft.id, 2, Y.encodeStateAsUpdate(doc));
    const versionId = await seedVersion(t.app, draft, w.owner.id);
    return { draft, versionKey: `versions/${versionId}` };
  };

  it('S06 AS-27: deleting a shop with 250 drafts purges them in batches of at most 100, stores and versions included, closes the rooms, resumes after a crash, and touches no other shop', async () => {
    const other = await createShopWorld(t);
    const { versionKey: otherVersion, draft: otherDraft } = await fullDraft(
      other.shop.id,
    );
    const mine = await Promise.all(
      Array.from({ length: 3 }, () => fullDraft(w.shop.id)),
    );
    await seedDrafts(t.app, w.shop.id, w.owner.id, 247);
    expect(await draftCount(t.app, `"shopId" = :s`, { s: w.shop.id })).toBe(
      250,
    );

    const editor = await openEditor(t, w.staff, w.shop.id, mine[0].draft.id);
    await editor.whenSynced();
    const consumer = t.app.get(DraftShopDeletedConsumer);
    const event = ShopDeleted.create(w.shop.id, 9, {
      shopId: w.shop.id,
      shopVersion: 9,
    });

    // The consumer crashes when it is about to remove the second batch.
    const original = drafts.deleteByIds.bind(drafts);
    const batches: number[] = [];
    let calls = 0;
    jest
      .spyOn(drafts, 'deleteByIds')
      .mockImplementation(async (shopId, ids) => {
        batches.push(ids.length);
        if (++calls === 2) throw new Error('crash between batches');
        return original(shopId, ids);
      });
    await expect(consumer.project([event])).rejects.toThrow(
      'crash between batches',
    );
    expect(await draftCount(t.app, `"shopId" = :s`, { s: w.shop.id })).toBe(
      150,
    );
    await waitFor(async () => editor.closed !== null, {
      timeoutMs: 5_000,
      description: 'room closed',
    });
    expect(editor.closed).toEqual({ code: 4003, reason: 'shop_inactive' });

    // Redelivery: the purge resumes and finishes.
    await consumer.project([event]);
    expect(await draftCount(t.app, `"shopId" = :s`, { s: w.shop.id })).toBe(0);
    expect(batches.every((n) => n <= 100)).toBe(true);
    expect(Math.max(...batches)).toBe(100);

    for (const { draft, versionKey } of mine) {
      expect(await versionRows(t.app, draft.id)).toHaveLength(0);
      expect(await logSeqs(t.app, draft.id)).toEqual([]);
      await expect(objects.get(versionKey)).rejects.toBeDefined();
      expect(await objects.list(`drafts/${draft.id}/`)).toEqual([]);
    }

    // A second full delivery changes nothing, and the other shop is untouched.
    await consumer.project([event]);
    expect(await draftCount(t.app, `"shopId" = :s`, { s: other.shop.id })).toBe(
      1,
    );
    expect(await versionRows(t.app, otherDraft.id)).toHaveLength(1);
    expect(await objects.get(otherVersion)).toBeInstanceOf(Uint8Array);
    expect((await logSeqs(t.app, otherDraft.id)).length).toBeGreaterThan(0);
    expect(
      (await objects.list(`drafts/${otherDraft.id}/`)).length,
    ).toBeGreaterThan(0);
  }, 180_000);
});
