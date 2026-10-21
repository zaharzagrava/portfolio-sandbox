import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { waitFor } from '@app/test/utils/async-helpers';
import { readTopic } from '@app/test/utils/kafka-test';
import { SearchEngineClient } from '@app/infrastructure/elasticsearch/search-engine.client';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { ConsumerKit } from '@app/infrastructure/events/testing/consumer-kit';
import type { Projector } from '@app/infrastructure/projections/projector';
import { PickupProjectionService } from './application/pickup-projection.service';
import { PickupPointProjector } from './infra/pickup-point.projector';
import { PickupProductProjector } from './infra/pickup-product.projector';
import { PickupShopProjector } from './infra/pickup-shop.projector';
import { PickupStockProjector } from './infra/pickup-stock.projector';
import { PickupProjectorModule } from './pickup-projector.module';
import {
  ALEX as ALEX_,
  createPickupApp,
  KREUZBERG,
  MITTE,
  type PickupTestApp,
  type PickupWorld,
} from './testing/pickup-fixtures';

type Doc = Record<string, unknown>;

describe('Pickup availability: index consumers, ordering, replay and observability', () => {
  let t: PickupTestApp;
  let w: PickupWorld;
  let point: { id: string };
  let product: { id: string; shopId: string };

  beforeAll(async () => {
    t = await createPickupApp();
  });
  afterAll(() => t.close());
  afterEach(() => {
    jest.restoreAllMocks();
  });
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
    await t.activateShop(w.s1.id);
    point = await t.createPoint(w.u1, w.s1.id, {
      ...KREUZBERG,
      name: 'Kreuzberg',
      address: 'Oranienstr. 1',
    });
    product = await t.product(w.s1.id, {
      title: 'AirPods Pro 3',
      category: 'audio',
      priceMinor: 24_900,
    });
  });

  const id = (p = point.id, pr = product.id) => `${p}:${pr}`;
  const patchPoint = (body: object, p = point.id) =>
    t
      .as(w.u1)
      .patch(`/api/shops/${w.s1.id}/pickup-points/${p}`)
      .send(body)
      .expect(200);
  const stockEvents = () => t.outbox('pickup.stock_changed');
  const envelopes = async (type: string) =>
    (
      await t.sql<{ payload: EventEnvelope }>(
        `SELECT "payload" FROM "Outbox" WHERE "topic" = 'pickup.events' AND "payload"->>'type' = :type ORDER BY "createdAt", "id"`,
        { type },
      )
    ).map((r) => r.payload);
  const feedStock = async (events: EventEnvelope[]) => {
    await t.feed(t.projectors.stock, events);
    await t.refreshIndex();
  };
  const bulkSpy = () => jest.spyOn(t.app.get(SearchEngineClient), 'bulk');

  describe('US3 - stock reaches the index', () => {
    it('S19 AS-24: a set to 4 shows the offer with the product current fields; 0 removes it; 2 brings it back', async () => {
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 4);
      await t.consume();

      expect(await t.documents()).toEqual({
        [id()]: expect.objectContaining({
          productId: product.id,
          pickupPointId: point.id,
          shopId: w.s1.id,
          title: 'AirPods Pro 3',
          category: 'audio',
          priceMinor: 24_900,
          currency: 'USD',
          pointName: 'Kreuzberg',
          pointAddress: 'Oranienstr. 1',
          quantity: 4,
          location: { lat: KREUZBERG.lat, lon: KREUZBERG.lng },
        }),
      });

      await t.setStock(w.u1, w.s1.id, point.id, product.id, 0);
      await t.consume();
      expect(await t.documents()).toEqual({});

      await t.setStock(w.u1, w.s1.id, point.id, product.id, 2);
      await t.consume();
      expect((await t.documents())[id()]).toMatchObject({ quantity: 2 });
    });

    it('S19 AS-24: the document carries the four source versions and their sum as the external version', async () => {
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 4);
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 5);
      await t.consume();

      const doc = (await t.documents())[id()] as Doc;
      expect(doc).toMatchObject({
        stockVersion: 2,
        pointVersion: 1,
        productVersion: 1,
        shopVersion: 1,
        docVersion: 5,
      });
    });
  });

  describe('US3 - ordering', () => {
    it('S19 AS-25: v2 (quantity 0) delivered and then v1 (quantity 5) late: the index still has no offer', async () => {
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 5);
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 0);
      const [v1, v2] = await envelopes('pickup.stock_changed');

      await feedStock([v2]);
      await feedStock([v1]);

      expect(await t.documents()).toEqual({});
    });

    it('S19 AS-25: a late older event cannot bring back stock that has gone after the offer was indexed', async () => {
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 5);
      await t.consume();
      expect(Object.keys(await t.documents())).toEqual([id()]);
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 0);
      await t.consume();
      const [v1] = await envelopes('pickup.stock_changed');

      await feedStock([v1]);

      expect(await t.documents()).toEqual({});
    });

    it('S19 AS-25: three events in every order, and repeated, end at the state of the exact store', async () => {
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 5);
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 0);
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 3);
      const [v1, v2, v3] = await envelopes('pickup.stock_changed');
      const orders = [
        [v1, v2, v3],
        [v3, v2, v1],
        [v2, v3, v1],
        [v1, v3, v2],
        [v3, v1, v2, v3, v1, v2],
      ];

      for (const order of orders) {
        await t.clearIndex();
        for (const e of order) await feedStock([e]);
        expect(await t.documents()).toEqual({
          [id()]: expect.objectContaining({ quantity: 3 }),
        });
      }
    });

    it('S19 AS-27: 30 edits in one batch are one index write and the index ends at the last one', async () => {
      for (let q = 1; q <= 30; q++)
        await t.setStock(w.u1, w.s1.id, point.id, product.id, q);
      const events = await envelopes('pickup.stock_changed');
      expect(events).toHaveLength(30);
      expect(t.projectors.stock.coalesce).toBe(true);
      const spy = bulkSpy();

      await feedStock(events);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toHaveLength(2); // one action line and one document
      expect((await t.documents())[id()]).toMatchObject({
        quantity: 30,
        stockVersion: 30,
      });
    });
  });

  describe('US3 - duplicates', () => {
    it('S19 AS-26: the stock consumer delivered the same batch twice leaves one document, the same as once', async () => {
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 4);
      const events = await envelopes('pickup.stock_changed');

      await feedStock(events);
      const once = await t.documents();
      await feedStock(events);

      expect(await t.documents()).toEqual(once);
      expect(Object.keys(once)).toEqual([id()]);
    });

    it('S19 AS-26: the point consumer delivered twice leaves one document with the new name', async () => {
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 4);
      await t.consume();
      await patchPoint({ name: 'Renamed' });
      const events = await envelopes('pickup.point_changed');

      await t.feed(t.projectors.point, events);
      await t.feed(t.projectors.point, events);
      await t.refreshIndex();

      const docs = await t.documents();
      expect(Object.keys(docs)).toEqual([id()]);
      expect(docs[id()]).toMatchObject({ pointName: 'Renamed' });
    });

    it('S19 AS-26: the product consumer delivered twice writes the copy once', async () => {
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 4);
      await t.consume();
      const update = t.events.productSnapshot('updated', product, 2, {
        title: 'AirPods Pro 4',
      });

      await t.feed(t.projectors.product, [update]);
      await t.feed(t.projectors.product, [update]);
      await t.refreshIndex();

      const copies = await t.sql<{ title: string; version: string }>(
        `SELECT "title", "version" FROM "PickupProductCopy"`,
      );
      expect(copies).toEqual([{ title: 'AirPods Pro 4', version: '2' }]);
      expect((await t.documents())[id()]).toMatchObject({
        title: 'AirPods Pro 4',
      });
    });

    it('S19 AS-26: the shop consumer delivered shop_deleted twice emits one point_changed per point and no more', async () => {
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 4);
      const second = await t.createPoint(w.u1, w.s1.id, MITTE);
      const before = (await t.outbox('pickup.point_changed')).length;
      const deleted = t.events.shopDeleted(w.s1.id, 5);

      await t.feed(t.projectors.shop, [deleted]);
      await t.feed(t.projectors.shop, [deleted]);

      const events = await t.outbox('pickup.point_changed');
      expect(events.length - before).toBe(2);
      expect(second.id).toBeDefined();
    });
  });

  describe('US3 - point changes', () => {
    it('S19 AS-28: a new name and address reach every offer of the point; a lower pointVersion arriving later changes nothing', async () => {
      const other = await t.product(w.s1.id, { title: 'AirPods Case' });
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 4);
      await t.setStock(w.u1, w.s1.id, point.id, other.id, 2);
      await t.consume();
      const [created] = await envelopes('pickup.point_changed');

      await patchPoint({ name: 'Renamed', address: 'New street 9' });
      await t.consume();
      expect(
        Object.values(await t.documents()).map((d) => [
          d.pointName,
          d.pointAddress,
        ]),
      ).toEqual([
        ['Renamed', 'New street 9'],
        ['Renamed', 'New street 9'],
      ]);

      await t.feed(t.projectors.point, [created]);
      await t.refreshIndex();
      expect(
        Object.values(await t.documents()).map((d) => d.pointName),
      ).toEqual(['Renamed', 'Renamed']);
    });

    it('S19 AS-28: active false removes every offer of the point; a stock event for the inactive point does not bring them back', async () => {
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 4);
      await t.consume();
      const [stockEvent] = await envelopes('pickup.stock_changed');

      await patchPoint({ active: false });
      await t.consume();
      expect(await t.documents()).toEqual({});

      await feedStock([stockEvent]);
      expect(await t.documents()).toEqual({});

      await patchPoint({ active: true });
      await t.consume();
      expect(Object.keys(await t.documents())).toEqual([id()]);
    });
  });

  describe('US3 - product changes', () => {
    beforeEach(async () => {
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 4);
      await t.consume();
    });

    it('S19 AS-29: a new title and price reach every offer; an older productVersion arriving later is ignored', async () => {
      const second = await t.createPoint(w.u1, w.s1.id, MITTE);
      await t.setStock(w.u1, w.s1.id, second.id, product.id, 1);
      await t.consume();

      await t.feed(t.projectors.product, [
        t.events.productSnapshot('updated', product, 2, {
          title: 'AirPods Pro 4',
          priceMinor: 19_900,
        }),
      ]);
      expect(
        Object.values(await t.documents()).map((d) => [d.title, d.priceMinor]),
      ).toEqual([
        ['AirPods Pro 4', 19_900],
        ['AirPods Pro 4', 19_900],
      ]);

      await t.feed(t.projectors.product, [
        t.events.productSnapshot('updated', product, 1, {
          title: 'Old',
          priceMinor: 1,
        }),
      ]);
      expect(Object.values(await t.documents()).map((d) => d.title)).toEqual([
        'AirPods Pro 4',
        'AirPods Pro 4',
      ]);
    });

    it('S19 AS-29: archived, sandbox and restored toggle the offer', async () => {
      const step = async (
        kind: 'archived' | 'restored' | 'updated',
        version: number,
        change = {},
      ) => {
        await t.feed(t.projectors.product, [
          t.events.productSnapshot(kind, product, version, change),
        ]);
        return Object.keys(await t.documents());
      };

      expect(await step('archived', 2, { status: 'ARCHIVED' })).toEqual([]);
      expect(await step('restored', 3, { status: 'ACTIVE' })).toEqual([id()]);
      expect(await step('updated', 4, { isSandbox: true })).toEqual([]);
      expect(await step('updated', 5, { isSandbox: false })).toEqual([id()]);
    });

    it('S19 AS-29: product_deleted removes the stock rows, emits one quantity-0 stock_changed per row at the next version, removes the offers and the copy', async () => {
      const second = await t.createPoint(w.u1, w.s1.id, MITTE);
      await t.setStock(w.u1, w.s1.id, second.id, product.id, 6);
      await t.setStock(w.u1, w.s1.id, second.id, product.id, 7); // version 2
      await t.consume();
      const before = (await stockEvents()).length;

      await t.feed(t.projectors.product, [t.events.productDeleted(product, 9)]);
      await t.feed(t.projectors.stock, await envelopes('pickup.stock_changed'));
      await t.refreshIndex();

      expect(
        await t.sql(`SELECT 1 FROM "PickupStock" WHERE "productId" = :id`, {
          id: product.id,
        }),
      ).toHaveLength(0);
      expect(
        await t.sql(
          `SELECT 1 FROM "PickupProductCopy" WHERE "productId" = :id`,
          { id: product.id },
        ),
      ).toHaveLength(0);
      const removed = (await stockEvents()).slice(before);
      expect(removed).toHaveLength(2);
      expect(
        removed
          .map((e) => [
            e.payload.pickupPointId,
            e.payload.quantity,
            e.payload.stockVersion,
          ])
          .sort(),
      ).toEqual(
        [
          [point.id, 0, 2],
          [second.id, 0, 3],
        ].sort(),
      );
      expect(await t.documents()).toEqual({});
    });

    it('S19 AS-29: an event for a product with no pickup stock is ignored: no copy row and no index write', async () => {
      const untracked = await t.product(w.s1.id);
      const spy = bulkSpy();

      await t.feed(t.projectors.product, [
        t.events.productSnapshot('updated', untracked, 2),
      ]);
      await t.feed(t.projectors.product, [
        t.events.productDeleted(untracked, 3),
      ]);

      expect(spy).not.toHaveBeenCalled();
      expect(
        await t.sql(
          `SELECT 1 FROM "PickupProductCopy" WHERE "productId" = :id`,
          { id: untracked.id },
        ),
      ).toHaveLength(0);
    });
  });

  describe('US3 - shop changes', () => {
    beforeEach(async () => {
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 4);
      await t.consume();
    });

    it('S19 AS-30: suspend hides the offers, reinstate shows them, an older shopVersion is ignored', async () => {
      await t.feed(t.projectors.shop, [
        t.events.shopStatus(w.s1.id, 'SUSPENDED', 2),
      ]);
      expect(await t.documents()).toEqual({});

      await t.feed(t.projectors.shop, [
        t.events.shopStatus(w.s1.id, 'ACTIVE', 3),
      ]);
      expect(Object.keys(await t.documents())).toEqual([id()]);

      // the suspension of version 2 arrives again after the reinstatement of version 3
      await t.feed(t.projectors.shop, [
        t.events.shopStatus(w.s1.id, 'SUSPENDED', 2),
      ]);
      expect(Object.keys(await t.documents())).toEqual([id()]);
    });

    it('S19 AS-30: shop_deleted deactivates every point with one event each, keeps the stock and hides the shop; repeating changes nothing', async () => {
      const second = await t.createPoint(w.u1, w.s1.id, MITTE);
      const before = (await t.outbox('pickup.point_changed')).length;

      await t.feed(t.projectors.shop, [t.events.shopDeleted(w.s1.id, 4)]);

      const events = (await t.outbox('pickup.point_changed')).slice(before);
      expect(
        events
          .map((e) => [
            e.payload.pickupPointId,
            e.payload.active,
            e.payload.pointVersion,
          ])
          .sort(),
      ).toEqual(
        [
          [point.id, false, 2],
          [second.id, false, 2],
        ].sort(),
      );
      expect(await t.documents()).toEqual({});
      expect(await t.sql(`SELECT 1 FROM "PickupStock"`)).toHaveLength(1);

      await t.feed(t.projectors.shop, [t.events.shopDeleted(w.s1.id, 4)]);
      expect((await t.outbox('pickup.point_changed')).length).toBe(before + 2);
    });

    it('S19 AS-30: a shop with no copy is not visible (fail closed)', async () => {
      const lonely = await t.createPoint(w.u2, w.s2.id, MITTE);
      const theirs = await t.product(w.s2.id);
      await t.setStock(w.u2, w.s2.id, lonely.id, theirs.id, 3);
      await t.consume();

      expect(Object.keys(await t.documents())).toEqual([id()]);
    });
  });

  describe('US7 - observability', () => {
    it('S19 AS-45: after traffic through the endpoints and the consumers the named series exist with fixed labels, the index lag is measured against the clock, and no log line holds coordinates, an address or a body', async () => {
      const lines: string[] = [];
      for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            lines.push(
              args
                .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
                .join(' '),
            );
          });
      const base = `/api/shops/${w.s1.id}/pickup-points/${point.id}/stock/${product.id}`;
      await t.activateShop(w.s2.id);

      // stock changes of every kind
      await t.as(w.u1).put(base).send({ quantity: 5 }).expect(200);
      await t
        .as(w.u1)
        .post(`${base}/adjustments`)
        .set('Idempotency-Key', uuidv7())
        .send({ delta: -1 })
        .expect(200);
      await t
        .as(w.u1)
        .post(`${base}/adjustments`)
        .set('Idempotency-Key', uuidv7())
        .send({ delta: -50 })
        .expect(409);
      // the write that fails inside its transaction: a generic 503, logged without the request
      jest
        .spyOn(t.app.get(OutboxService), 'append')
        .mockRejectedValueOnce(new Error('boom'));
      const failed = await t
        .as(w.u1)
        .put(base)
        .send({ quantity: 9 })
        .expect(503);
      expect(failed.body.requestId).toBeTruthy();

      // the index lag: the newest applied event against the frozen clock
      await t.as(w.u1).put(base).send({ quantity: 7 }).expect(200);
      t.clock.advance(7_000);
      await t.consume();
      expect(MetricsRegistry.value('pickup_index_lag_seconds')).toBe(7);

      // reads through every endpoint, one of them failing
      const query = { lat: ALEX_.lat, lng: ALEX_.lng };
      await t.http().get('/api/search/near').query(query).expect(200);
      await t.http().get('/api/pickup-points/near').query(query).expect(200);
      await t
        .http()
        .get('/api/pickup-points/clusters')
        .query({ bbox: '52.7,13.1,52.3,13.7' })
        .expect(200);
      jest
        .spyOn(t.app.get(SearchEngineClient), 'search')
        .mockRejectedValueOnce(new Error('connection to elastic refused'));
      await t.http().get('/api/search/near').query(query).expect(503);

      // an index write that the engine refuses
      jest.spyOn(t.app.get(SearchEngineClient), 'bulk').mockResolvedValueOnce({
        items: [
          {
            index: { status: 400, error: { type: 'mapper_parsing_exception' } },
          },
        ],
      });
      await expect(
        t.feed(t.projectors.stock, await envelopes('pickup.stock_changed')),
      ).rejects.toThrow();

      const count = (name: string, labels: Record<string, string>) =>
        MetricsRegistry.value(name, labels) ?? 0;
      expect(
        count('pickup_stock_changes_total', { kind: 'set' }),
      ).toBeGreaterThanOrEqual(2);
      expect(
        count('pickup_stock_changes_total', { kind: 'adjust' }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        count('pickup_stock_changes_total', { kind: 'rejected' }),
      ).toBeGreaterThanOrEqual(1);
      for (const endpoint of ['search', 'browse', 'clusters'])
        expect(
          MetricsRegistry.histogramValue('pickup_search_duration_seconds', {
            endpoint,
            outcome: 'ok',
          })?.count,
        ).toBeGreaterThanOrEqual(1);
      expect(
        MetricsRegistry.histogramValue('pickup_search_duration_seconds', {
          endpoint: 'search',
          outcome: 'unavailable',
        })?.count,
      ).toBeGreaterThanOrEqual(1);
      expect(
        count('pickup_http_rejections_total', {
          endpoint: 'search',
          code: '503',
        }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        count('pickup_index_write_failures_total', {}),
      ).toBeGreaterThanOrEqual(1);

      // fixed labels only: no id, coordinate, address or request id ever becomes a label value
      const allowed = new Set([
        'search',
        'browse',
        'clusters',
        'ok',
        'unavailable',
        '503',
        'set',
        'adjust',
        'rejected',
      ]);
      for (const metric of [
        'pickup_search_duration_seconds',
        'pickup_http_rejections_total',
        'pickup_stock_changes_total',
      ])
        for (const labels of MetricsRegistry.labelSets(metric))
          for (const value of Object.values(labels))
            expect(allowed.has(String(value))).toBe(true);

      // logs: nothing of the shopper's position, a point's address or a body
      const text = lines.join('\n');
      for (const secret of [
        String(ALEX_.lat),
        String(ALEX_.lng),
        'Oranienstr',
        '"quantity"',
        'Idempotency-Key',
      ])
        expect(text).not.toContain(secret);
      expect(lines.some((l) => /pickup/i.test(l))).toBe(true);
    });
  });

  describe('US3 - replay', () => {
    it('S19 AS-31: emptying the index and replaying every event shuffled, twice, gives the documents of the live index', async () => {
      const second = await t.createPoint(w.u1, w.s1.id, {
        ...MITTE,
        name: 'Mitte',
      });
      const other = await t.product(w.s1.id, {
        title: 'AirPods Case',
        category: 'audio',
      });
      await t.setStock(w.u1, w.s1.id, point.id, product.id, 4);
      await t.setStock(w.u1, w.s1.id, second.id, product.id, 2);
      await t.setStock(w.u1, w.s1.id, second.id, other.id, 7);
      await t.setStock(w.u1, w.s1.id, point.id, other.id, 0);
      await patchPoint({ name: 'Renamed' });
      const productEvents = [
        t.events.productSnapshot('updated', product, 2, {
          title: 'AirPods Pro 4',
        }),
        t.events.productSnapshot('updated', other, 2, {
          title: 'AirPods Case 2',
        }),
      ];
      const shopEvents = [
        t.events.shopStatus(w.s1.id, 'SUSPENDED', 2),
        t.events.shopStatus(w.s1.id, 'ACTIVE', 3),
      ];
      await t.consume();
      await t.feed(t.projectors.product, productEvents);
      await t.feed(t.projectors.shop, shopEvents);
      const live = await t.documents();
      expect(Object.keys(live)).toHaveLength(3);

      await t.clearIndex();
      const stock = await envelopes('pickup.stock_changed');
      const points = await envelopes('pickup.point_changed');
      const shuffled = <T>(items: T[]) =>
        [...items, ...items].sort(() => Math.random() - 0.5);
      for (const run of [1, 2]) {
        expect(run).toBeGreaterThan(0);
        for (const e of shuffled(stock)) await t.feed(t.projectors.stock, [e]);
        for (const e of shuffled(points)) await t.feed(t.projectors.point, [e]);
        for (const e of shuffled(productEvents))
          await t.feed(t.projectors.product, [e]);
        for (const e of shuffled(shopEvents))
          await t.feed(t.projectors.shop, [e]);
      }

      expect(await t.documents()).toEqual(live);
    });
  });
});

describe('Pickup availability consumers on the real consumer framework', () => {
  let t: PickupTestApp;
  const kit = new ConsumerKit();

  beforeAll(async () => {
    t = await createPickupApp();
    await kit.start();
  });
  afterAll(async () => {
    await kit.stopAll();
    await t.close();
  });
  beforeEach(() => t.reset());

  /** A second message of the same kind, so "the rest of the batch is applied" has something to show. */
  const corrupt = (e: EventEnvelope) => ({
    badId: { ...e, aggregateId: 'not-an-id' },
    badPayload: {
      ...e,
      payload: {
        ...e.payload,
        shopId: 7,
        productId: 7,
        pickupPointId: 7,
        to: 'NOWHERE',
      },
    },
    newer: { ...e, version: 2 },
    unknownType: { ...e, type: `${e.type}_wat` },
  });

  it.each(['stock', 'point', 'product', 'shop'] as const)(
    'S19 AS-26: the %s consumer dead-letters a bad aggregate id, a bad payload and a newer contract version, ignores an unknown type, and applies the messages around them',
    async (kind) => {
      const w = await t.world();
      await t.activateShop(w.s1.id);
      const pointA = await t.createPoint(w.u1, w.s1.id, {
        ...KREUZBERG,
        name: 'A',
      });
      const pointB = await t.createPoint(w.u1, w.s1.id, {
        ...MITTE,
        name: 'B',
      });
      const prod = await t.product(w.s1.id, { title: 'Original' });
      await t.setStock(w.u1, w.s1.id, pointA.id, prod.id, 3);
      await t.setStock(w.u1, w.s1.id, pointB.id, prod.id, 3);
      await t.consume();
      const second = await t.createPoint(w.u2, w.s2.id, {
        ...MITTE,
        name: 'Second',
      });
      const secondProduct = await t.product(w.s2.id);

      let first: EventEnvelope;
      let last: EventEnvelope;
      let Base: new (...args: never[]) => Projector;
      let verify: () => Promise<void>;
      if (kind === 'stock') {
        await t.setStock(w.u1, w.s1.id, pointA.id, prod.id, 9);
        await t.setStock(w.u2, w.s2.id, second.id, secondProduct.id, 5);
        const events = await envelopesOf(t, 'pickup.stock_changed');
        [first, last] = [events.at(-2)!, events.at(-1)!];
        Base = PickupStockProjector;
        verify = async () => {
          const docs = await t.documents();
          expect(docs[`${pointA.id}:${prod.id}`]).toMatchObject({
            quantity: 9,
          });
        };
      } else if (kind === 'point') {
        await t
          .as(w.u1)
          .patch(`/api/shops/${w.s1.id}/pickup-points/${pointA.id}`)
          .send({ name: 'A2' })
          .expect(200);
        await t
          .as(w.u1)
          .patch(`/api/shops/${w.s1.id}/pickup-points/${pointB.id}`)
          .send({ name: 'B2' })
          .expect(200);
        const events = await envelopesOf(t, 'pickup.point_changed');
        [first, last] = [events.at(-2)!, events.at(-1)!];
        Base = PickupPointProjector;
        verify = async () => {
          const names = Object.values(await t.documents())
            .map((d) => d.pointName)
            .sort();
          expect(names).toEqual(['A2', 'B2']);
        };
      } else if (kind === 'product') {
        first = t.events.productSnapshot('updated', prod, 2, {
          title: 'Changed',
        });
        last = t.events.productSnapshot('updated', prod, 3, {
          title: 'Changed again',
        });
        Base = PickupProductProjector;
        verify = async () => {
          expect(
            Object.values(await t.documents()).map((d) => d.title),
          ).toEqual(['Changed again', 'Changed again']);
        };
      } else {
        first = t.events.shopStatus(w.s1.id, 'SUSPENDED', 2);
        last = t.events.shopCreated(w.s2.id, 1);
        Base = PickupShopProjector;
        verify = async () => {
          expect(await t.documents()).toEqual({});
          const copies = await t.sql<{ shopId: string; status: string }>(
            `SELECT "shopId", "status" FROM "PickupShopCopy" ORDER BY "status"`,
          );
          expect(copies.map((c) => c.status)).toEqual(['ACTIVE', 'SUSPENDED']);
        };
      }

      const s = await kit.scenario();
      const name = `pickup-${kind}-${s.id}`;
      @Injectable()
      class Sub extends (Base as new (
        p: PickupProjectionService,
      ) => Projector) {
        readonly name = name;
        readonly topics = [s.topic];
      }
      await s.boot([Sub as never], { imports: [PickupProjectorModule] });
      const bad = corrupt(first);
      await s.publishRaw(
        [
          first,
          bad.badId,
          bad.badPayload,
          bad.newer,
          bad.unknownType,
          last,
        ].map((e) => ({
          key: e.aggregateId,
          value: JSON.stringify(e),
        })),
      );

      const dlq = () => readTopic(`${name}.dlq`);
      await waitFor(async () => (await dlq()).length === 3, {
        description: 'three dead letters',
      });
      await waitFor(
        async () => {
          try {
            await t.refreshIndex();
            await verify();
            return true;
          } catch {
            return false;
          }
        },
        { description: 'the valid messages applied' },
      );
      const codes = (await dlq())
        .map((l) => l.headers['x-dlq-reason-code'])
        .sort();
      expect(codes).toEqual([
        'INVALID_AGGREGATE_ID',
        'INVALID_PAYLOAD',
        'UNSUPPORTED_VERSION',
      ]);
      for (const letter of await dlq())
        expect(letter.headers['x-dlq-reason']).toBeTruthy();
    },
    120_000,
  );
});

async function envelopesOf(
  t: PickupTestApp,
  type: string,
): Promise<EventEnvelope[]> {
  return (
    await t.sql<{ payload: EventEnvelope }>(
      `SELECT "payload" FROM "Outbox" WHERE "topic" = 'pickup.events' AND "payload"->>'type' = :type ORDER BY "createdAt", "id"`,
      { type },
    )
  ).map((r) => r.payload);
}
