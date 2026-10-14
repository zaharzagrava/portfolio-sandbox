import { ShopDeleted, ShopStatusChanged } from '@app/domains/tenancy';
import { PermanentError } from '@app/infrastructure/projections/errors';
import {
  createKey,
  createPublicApiKit,
  newId,
  outboxEvents,
  rows,
  type PublicApiKit,
} from './testing/public-api-kit';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { PublicApiProjectorModule } from './public-api-projector.module';
import { PublicApiShopLifecycleConsumer } from './infra/consumers';
import { ApiRequestsProjector } from './infra/api-requests.projector';
import { requestLoggedEnvelope } from './infra/kafka-request-record.publisher';
import type { RequestRecord } from './domain/ports';

describe('Developer platform: consumers (shop lifecycle, request log, usage)', () => {
  let t: PublicApiKit;

  beforeAll(async () => {
    t = await createPublicApiKit({
      dashboardImports: [PublicApiProjectorModule],
    });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  describe('shop lifecycle consumer (AS-12)', () => {
    const lifecycle = () => t.app.get(PublicApiShopLifecycleConsumer);
    /** A schema-valid envelope; `payload` replaces the body after creation (the producer side refuses invalid ones). */
    const deleted = (shopId: string, payload?: Record<string, unknown>) => ({
      ...ShopDeleted.create(shopId, 2, { shopId, shopVersion: 2 }),
      ...(payload ? { payload } : {}),
    });
    const keyStates = (shopId: string) =>
      rows<{ id: string; revokedAt: Date | null }>(
        t.app,
        `SELECT id, "revokedAt" FROM "ApiKey" WHERE "shopId" = :shopId ORDER BY "createdAt"`,
        { shopId },
      );
    const revokedEvents = (shopId: string) =>
      outboxEvents(t.app, 'developerplatform.api_key_revoked', { shopId });

    it('S42 AS-12: shop_deleted revokes all 3 keys once (reason shop_deleted) and every call answers 401', async () => {
      const w = await t.seedWorld();
      const keys = [
        await createKey(t, w, { name: 'one' }),
        await createKey(t, w, { name: 'two', livemode: false }),
        await createKey(t, w, { name: 'three' }),
      ];
      for (const k of keys)
        expect((await t.pub.withKey(k.key).get('/v1/products')).status).toBe(
          200,
        );

      await lifecycle().project([deleted(w.shop.id)]);

      expect(
        (await keyStates(w.shop.id)).every((k) => k.revokedAt !== null),
      ).toBe(true);
      const events = await revokedEvents(w.shop.id);
      expect(events).toHaveLength(3);
      expect(events.every((e) => e.payload.reason === 'shop_deleted')).toBe(
        true,
      );
      expect(events.map((e) => e.aggregateId).sort()).toEqual(
        keys.map((k) => k.id).sort(),
      );
      for (const k of keys)
        expect((await t.pub.withKey(k.key).get('/v1/products')).status).toBe(
          401,
        );
    });

    it('S42 AS-12: a second delivery, or two at once, changes nothing and emits no event', async () => {
      const w = await t.seedWorld();
      await createKey(t, w);
      await createKey(t, w);
      const consumer = lifecycle();
      await Promise.all([
        consumer.project([deleted(w.shop.id)]),
        consumer.project([deleted(w.shop.id)]),
      ]);
      const before = await keyStates(w.shop.id);
      expect(await revokedEvents(w.shop.id)).toHaveLength(2);
      await consumer.project([deleted(w.shop.id)]);
      expect(await keyStates(w.shop.id)).toEqual(before);
      expect(await revokedEvents(w.shop.id)).toHaveLength(2);
    });

    it('S42 AS-12: another shop’s keys are not touched', async () => {
      const a = await t.seedWorld();
      const b = await t.seedWorld();
      await createKey(t, a);
      const kept = await createKey(t, b);
      await lifecycle().project([deleted(a.shop.id)]);
      expect((await t.pub.withKey(kept.key).get('/v1/products')).status).toBe(
        200,
      );
    });

    it.each<[string, unknown]>([
      ['a missing shopId', undefined],
      ['a shopId that is not a UUID', 'not-a-uuid'],
      ['a shopId of the wrong type', 42],
    ])(
      'S42 AS-12: %s is dead-lettered and nothing changes',
      async (_n, shopId) => {
        const w = await t.seedWorld();
        await createKey(t, w);
        const before = await keyStates(w.shop.id);
        await expect(
          lifecycle().project([deleted(w.shop.id, { shopId, shopVersion: 2 })]),
        ).rejects.toBeInstanceOf(PermanentError);
        expect(await keyStates(w.shop.id)).toEqual(before);
        expect(await revokedEvents(w.shop.id)).toHaveLength(0);
      },
    );

    it('S42 AS-62: the request-log projector stores a record once, however it is delivered', async () => {
      const projector = t.app.get(ApiRequestsProjector);
      const clickhouse = t.app.get(ClickHouseService);
      const shopId = newId();
      const rec: RequestRecord = {
        requestId: `req_${newId().replace(/-/g, '')}`,
        shopId,
        keyId: 'k',
        livemode: true,
        version: '2026-10-01',
        method: 'GET',
        route: '/v1/products',
        status: 200,
        durationMs: 3,
        deprecated: false,
        idempotentReplay: false,
        cost: 1,
        occurredAt: new Date('2026-10-06T11:59:00.000Z'),
      };
      const stored = async () =>
        Number(
          (
            await clickhouse.query<{ n: string }>(
              `SELECT count() AS n FROM api_requests WHERE shop_id = {shopId:String} AND request_id = {id:String}`,
              { shopId, id: rec.requestId },
            )
          )[0].n,
        );
      const envelope = requestLoggedEnvelope(rec);
      await projector.project([envelope]);
      await projector.project([envelope]);
      expect(await stored()).toBe(1);
      // the same request under a new event id
      await projector.project([{ ...envelope, eventId: newId() }]);
      expect(await stored()).toBe(1);
      // a record of a shop this capability has never seen is stored, not rejected
      expect(await stored()).toBe(1);
    });

    it('S42 AS-62: a payload that fails the schema is dead-lettered and writes no row', async () => {
      const projector = t.app.get(ApiRequestsProjector);
      const clickhouse = t.app.get(ClickHouseService);
      const shopId = newId();
      const bad = {
        ...requestLoggedEnvelope({
          requestId: 'req_bad',
          shopId,
          keyId: 'k',
          livemode: true,
          version: 'v',
          method: 'GET',
          route: '/x',
          status: 200,
          durationMs: 1,
          deprecated: false,
          idempotentReplay: false,
          cost: 1,
          occurredAt: new Date(),
        }),
        payload: { requestId: 'req_bad', shopId, status: 'ok' },
      };
      await expect(projector.project([bad as never])).rejects.toBeInstanceOf(
        PermanentError,
      );
      const [{ n }] = await clickhouse.query<{ n: string }>(
        `SELECT count() AS n FROM api_requests WHERE shop_id = {shopId:String}`,
        { shopId },
      );
      expect(Number(n)).toBe(0);
    });

    it('S42 AS-17: shop_status_changed with a payload that is not valid is dead-lettered', async () => {
      await expect(
        lifecycle().project([
          {
            ...ShopStatusChanged.create(newId(), 2, {
              shopId: newId(),
              from: 'ACTIVE',
              to: 'SUSPENDED',
              shopVersion: 2,
            }),
            payload: { shopId: 'x', from: 'ACTIVE', shopVersion: 'two' },
          },
        ]),
      ).rejects.toBeInstanceOf(PermanentError);
    });
  });
});
