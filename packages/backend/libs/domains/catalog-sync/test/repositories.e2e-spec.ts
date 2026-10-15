import { QueryTypes, Sequelize } from 'sequelize';
import { v4, v7 } from 'uuid';
import type { ApiConfigService } from '@app/common/config';
import { enableSequelizeCls } from '@app/infrastructure/context/sequelize-cls';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  KeysetCursorCodec,
  SequelizeConflictRepository,
  SequelizeCursorRepository,
  SequelizeInstallRepository,
  SequelizeIntegrationRepository,
  SequelizeLinkRepository,
  SequelizeQuarantineRepository,
  SequelizeReceiptRepository,
  SequelizeReconciliationRepository,
} from '../infra/repositories';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbConfig = require('../../../../configs/db.config.js').test;

const KEY = 'catalog-sync-test-cursor-key-0123456789abcdef';

/** T012: the repositories against the real schema (expand migration applied on the test stack). */
describe('catalog-sync repositories (e2e)', () => {
  let db: Sequelize;
  let integrations: SequelizeIntegrationRepository;
  let links: SequelizeLinkRepository;
  let cursors: SequelizeCursorRepository;
  let quarantine: SequelizeQuarantineRepository;
  let conflicts: SequelizeConflictRepository;
  let receipts: SequelizeReceiptRepository;
  let reconciliations: SequelizeReconciliationRepository;
  let installs: SequelizeInstallRepository;
  const created: string[] = [];
  const now = new Date('2026-10-15T12:00:00.000Z');

  beforeAll(() => {
    enableSequelizeCls();
    db = new Sequelize({ ...dbConfig, logging: false });
    new TransactionRunner(db as never);
    const config = { get: () => KEY } as unknown as ApiConfigService;
    integrations = new SequelizeIntegrationRepository(db, config);
    links = new SequelizeLinkRepository(db);
    cursors = new SequelizeCursorRepository(db);
    quarantine = new SequelizeQuarantineRepository(db, config);
    conflicts = new SequelizeConflictRepository(db, config);
    receipts = new SequelizeReceiptRepository(db);
    reconciliations = new SequelizeReconciliationRepository(db, config);
    installs = new SequelizeInstallRepository(db);
  });

  afterAll(async () => {
    if (created.length) {
      await db.query(
        `DELETE FROM "IntegrationHistory" WHERE "integrationId" IN (:ids)`,
        { replacements: { ids: created } },
      );
      await db.query(
        `DELETE FROM "CatalogReconciliationRun" WHERE "integrationId" IN (:ids)`,
        { replacements: { ids: created } },
      );
      await db.query(
        `DELETE FROM "StockConflict" WHERE "integrationId" IN (:ids)`,
        { replacements: { ids: created } },
      );
      await db.query(
        `DELETE FROM "WebhookReceipt" WHERE "integrationId" IN (:ids)`,
        { replacements: { ids: created } },
      );
      await db.query(`DELETE FROM "Integration" WHERE "id" IN (:ids)`, {
        replacements: { ids: created },
      });
    }
    await db.close();
  });

  const connect = async (
    shopId = v4(),
    maxPerShop = 5,
    externalShop = `s-${v4()}.myshopify.com`,
  ) => {
    const id = v7();
    created.push(id);
    const result = await integrations.insertConnected({
      id,
      shopId,
      provider: 'shopify',
      externalShop,
      credentialsSealed: 'sealed',
      locationId: 'loc',
      connectedBy: v4(),
      now,
      maxPerShop,
    });
    return { id, shopId, externalShop, result };
  };

  it('connects once per store, enforces the per-shop limit, and lists with a tamper-evident cursor', async () => {
    const shopId = v4();
    const a = await connect(shopId, 2);
    expect(a.result.kind).toBe('inserted');
    expect((await connect(shopId, 2, a.externalShop)).result.kind).toBe(
      'store_already_connected',
    );
    const b = await connect(shopId, 2);
    expect(b.result.kind).toBe('inserted');
    expect((await connect(shopId, 2)).result.kind).toBe('limit_reached');
    expect(await integrations.countActiveForShop(shopId)).toBe(2);

    const first = await integrations.listPage(shopId, { limit: 1 });
    expect(first.items.map((i) => i.id)).toEqual([b.id]);
    expect(first.nextCursor).not.toBeNull();
    const second = await integrations.listPage(shopId, {
      limit: 1,
      cursor: first.nextCursor as string,
    });
    expect(second.items.map((i) => i.id)).toEqual([a.id]);
    expect(second.nextCursor).toBeNull();

    const tampered = `${(first.nextCursor as string).slice(0, -2)}xx`;
    await expect(
      integrations.listPage(shopId, { limit: 1, cursor: tampered }),
    ).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    await expect(
      integrations.listPage(v4(), {
        limit: 1,
        cursor: first.nextCursor as string,
      }),
    ).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
  });

  it('finds an integration only inside its shop and transitions conditionally', async () => {
    const { id, shopId } = await connect();
    expect(await integrations.findInShop(shopId, id)).toMatchObject({
      id,
      status: 'ACTIVE',
    });
    expect(await integrations.findInShop(v4(), id)).toBeNull();

    const paused = await integrations.transition(id, 'ACTIVE', 'PAUSED', {
      reason: 'pause',
      actorId: null,
      now,
      pausedReason: 'seller',
    });
    expect(paused).toMatchObject({ status: 'PAUSED', pausedReason: 'seller' });
    expect(
      await integrations.transition(id, 'ACTIVE', 'PAUSED', {
        reason: 'pause',
        actorId: null,
        now,
      }),
    ).toBeNull();
    const [{ n }] = (await db.query(
      `SELECT count(*)::int AS n FROM "IntegrationHistory" WHERE "integrationId" = :id`,
      {
        replacements: { id },
        type: QueryTypes.SELECT,
      },
    )) as Array<{ n: number }>;
    expect(n).toBe(2); // connect + pause; the refused transition wrote nothing

    const gone = await integrations.transition(id, 'PAUSED', 'DISCONNECTED', {
      reason: 'disconnect',
      actorId: null,
      now,
      eraseCredentials: true,
    });
    expect(gone).toMatchObject({
      status: 'DISCONNECTED',
      credentialsSealed: null,
    });
  });

  it('fences the sync lease', async () => {
    const { id } = await connect();
    const f1 = await cursors.claimLease(id, 'product', 'a', 60_000, now);
    expect(f1).toBe(1);
    expect(
      await cursors.claimLease(id, 'product', 'b', 60_000, now),
    ).toBeNull();
    expect(await cursors.checkpoint(id, 'product', 1, 'page-2')).toBe(true);
    const later = new Date(now.getTime() + 61_000);
    const f2 = await cursors.claimLease(id, 'product', 'b', 60_000, later);
    expect(f2).toBe(2);
    expect(await cursors.checkpoint(id, 'product', 1, 'stale')).toBe(false);
    expect(await cursors.advanceWatermark(id, 'product', 1, later)).toBe(false);
    expect(await cursors.advanceWatermark(id, 'product', 2, later)).toBe(true);
    expect(await cursors.advanceWatermark(id, 'product', 2, now)).toBe(true);
    expect((await cursors.read(id, 'product'))?.watermark?.toISOString()).toBe(
      later.toISOString(),
    );
  });

  it('keeps one OPEN quarantine entry per dedupe key and counts occurrences', async () => {
    const { id } = await connect();
    const input = {
      integrationId: id,
      entity: 'product',
      externalId: '1:2',
      dedupeKey: '1:2',
      payloadDigest: null,
      reasonCode: 'invalid_price',
      message: 'bad',
      payload: { a: 1 },
    };
    const [x, y] = await Promise.all([
      quarantine.record(input, now),
      quarantine.record(input, now),
    ]);
    expect(x.id).toBe(y.id);
    expect(await quarantine.countOpen(id)).toBe(1);
    expect(await quarantine.resolveByDedupeKey(id, 'product', '1:2', now)).toBe(
      1,
    );
    expect(
      await quarantine.close(id, x.id, 'DISMISSED', 'dismissed', null, now),
    ).toBeNull();
    const again = await quarantine.record(input, now);
    expect(again.id).not.toBe(x.id);
    expect(
      (
        await quarantine.close(
          id,
          again.id,
          'DISMISSED',
          'dismissed',
          v4(),
          now,
        )
      )?.status,
    ).toBe('DISMISSED');
  });

  it('opens a stock conflict once and dismisses it once', async () => {
    const { id, shopId } = await connect();
    const input = {
      integrationId: id,
      shopId,
      externalId: '1:2',
      productId: v4(),
      kind: 'oversold' as const,
      base: 5,
      local: 1,
      remote: 2,
      merged: -2,
      resolvedTo: 0,
    };
    const first = await conflicts.open(input, now);
    const second = await conflicts.open(input, now);
    expect(first.created).toBe(true);
    expect(second).toMatchObject({
      created: false,
      conflict: { id: first.conflict.id },
    });
    expect(
      await conflicts.dismiss(id, first.conflict.id, v4(), 'ok', now),
    ).toMatchObject({ status: 'DISMISSED' });
    expect(
      await conflicts.dismiss(id, first.conflict.id, v4(), 'ok', now),
    ).toBeNull();
  });

  it('consumes an install state once, and records a webhook delivery once', async () => {
    const digest = v4();
    await installs.create(
      {
        shopId: v4(),
        userId: v4(),
        shopDomain: 'x.myshopify.com',
        stateDigest: digest,
      },
      now,
    );
    expect(
      await installs.consume(digest, new Date(now.getTime() + 11 * 60_000)),
    ).toBeNull(); // expired
    const [a, b] = await Promise.all([
      installs.consume(digest, now),
      installs.consume(digest, now),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);

    const { id } = await connect();
    expect(await receipts.insertIfNew(id, 'd1', now)).toBe(true);
    expect(await receipts.insertIfNew(id, 'd1', now)).toBe(false);
    await receipts.remove(id, 'd1');
    expect(await receipts.insertIfNew(id, 'd1', now)).toBe(true);
  });

  it('caps stored findings at 1,000 and refuses a second finish', async () => {
    const { id } = await connect();
    const run = await reconciliations.start(id, now, null);
    const findings = Array.from({ length: 1001 }, (_, i) => ({
      kind: 'matched',
      externalId: String(i),
    }));
    expect(
      await reconciliations.finish(
        run,
        { outcome: 'completed', counts: { matched: 1001 }, findings },
        now,
      ),
    ).toBe(true);
    expect(
      await reconciliations.finish(
        run,
        { outcome: 'failed', counts: {}, findings: [] },
        now,
      ),
    ).toBe(false);
    const report = await reconciliations.findInIntegration(id, run);
    expect(report?.findings).toHaveLength(1000);
    expect(report?.truncated).toBe(true);
  });

  it('writes links with a single predicate and never revives an IGNORED one', async () => {
    const { id, shopId } = await connect();
    const localId = v4();
    await links.upsertApplied({
      integrationId: id,
      shopId,
      externalId: '1:2',
      localId,
      contentDigest: 'd',
      syncedStock: 3,
      remoteUpdatedAt: now,
      raw: { a: 1 },
    });
    expect(await links.findByLocal(shopId, localId)).toHaveLength(1);
    expect(await links.findByLocal(v4(), localId)).toHaveLength(0);
    expect(await links.ignoreByLocal(shopId, localId)).toBe(1);
    expect(await links.markState(id, '1:2', 'ACTIVE')).toBe(false);
  });

  it('rejects a foreign cursor key', () => {
    const a = new KeysetCursorCodec(KEY);
    const cursor = a.encode('s', '2026-10-15 12:00:00+00', v4());
    expect(() =>
      new KeysetCursorCodec(`${KEY}x`).decode('s', cursor),
    ).toThrow();
  });
});
