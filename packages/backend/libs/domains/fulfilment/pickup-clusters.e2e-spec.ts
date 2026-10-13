import { pickupClustersResponseSchema } from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { SearchEngineClient } from '@app/infrastructure/elasticsearch/search-engine.client';
import { AVAILABILITY_INDEX } from './infra/availability-index';
import {
  createPickupApp,
  KREUZBERG,
  MITTE,
  SPANDAU,
  type PickupTestApp,
  type PickupWorld,
} from './testing/pickup-fixtures';

const BERLIN = '52.7,13.1,52.3,13.7';
const HAMBURG = { lat: 53.5511, lng: 9.9937 };
const MUNICH = { lat: 48.1351, lng: 11.582 };
const COLOGNE = { lat: 50.9375, lng: 6.9603 };
const GERMANY = '55.5,5.5,47,15.5';

interface Cell {
  cellId: string;
  offers: number;
  pickupPoints: number;
  lat: number;
  lng: number;
  pickupPointId?: string;
}

describe('Pickup map clusters', () => {
  let t: PickupTestApp;
  let w: PickupWorld;

  beforeAll(async () => {
    t = await createPickupApp({ proxies: { redis: true, search: true } });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
    await t.activateShop(w.s1.id);
  });

  const clusters = (query: Record<string, unknown> = {}) =>
    t
      .http()
      .get('/api/pickup-points/clusters')
      .query({ bbox: BERLIN, zoom: '10', ...query });
  const cellsOf = async (query: Record<string, unknown> = {}) =>
    pickupClustersResponseSchema.parse(
      (await clusters(query).expect(200)).body,
    );
  const sum = (cells: Cell[], key: 'offers' | 'pickupPoints') =>
    cells.reduce((s, c) => s + c[key], 0);
  /** Points with in-stock offers of the given products. */
  const offer = async (
    where: { lat: number; lng: number },
    products: { id: string }[],
    quantity = 1,
  ) => {
    const p = await t.createPoint(w.u1, w.s1.id, where);
    for (const product of products)
      await t.setStock(w.u1, w.s1.id, p.id, product.id, quantity);
    return p;
  };

  describe('US5 - viewport', () => {
    it('S19 AS-34: offers count in-stock pairs, pickupPoints the distinct points, the centroid is the cell position; out-of-stock offers and offers outside the box are not counted', async () => {
      const [a, b] = await Promise.all([
        t.product(w.s1.id),
        t.product(w.s1.id),
      ]);
      const mitte = await offer(MITTE, [a, b]);
      const kreuzberg = await offer(KREUZBERG, [a, b]);
      const spandau = await offer(SPANDAU, [a]);
      await offer(MUNICH, [a]); // outside the box
      await offer({ lat: 52.51, lng: 13.38 }, [a, b], 0); // out of stock
      await t.consume();

      const body = await cellsOf();

      expect(body.truncated).toBe(false);
      expect(sum(body.cells, 'offers')).toBe(5);
      expect(sum(body.cells, 'pickupPoints')).toBe(3);
      for (const cell of body.cells) {
        expect(cell.cellId).toMatch(/^10\/\d+\/\d+$/);
        expect(cell.lat).toBeGreaterThan(52.3);
        expect(cell.lat).toBeLessThan(52.7);
      }
      // the lonely Spandau offer is its own cell at this zoom and sits where the point is
      const lonely = body.cells.find((c) => c.pickupPointId === spandau.id)!;
      expect(lonely).toMatchObject({ offers: 1, pickupPoints: 1 });
      expect(lonely.lat).toBeCloseTo(SPANDAU.lat, 3);
      expect(lonely.lng).toBeCloseTo(SPANDAU.lng, 3);
      expect([mitte.id, kreuzberg.id]).toBeDefined();
    });

    it('S19 AS-35: zooming in never merges cells, the offers over all cells stay the same, cells nest, and the zoom is 0…20', async () => {
      const a = await t.product(w.s1.id);
      for (const where of [MITTE, KREUZBERG, SPANDAU, HAMBURG, MUNICH, COLOGNE])
        await offer(where, [a]);
      await t.consume();

      const at = async (zoom: number) =>
        (await cellsOf({ bbox: GERMANY, zoom: String(zoom) })).cells;
      const [z3, z8, z14] = [await at(3), await at(8), await at(14)];

      expect(z3.length).toBeLessThanOrEqual(z8.length);
      expect(z8.length).toBeLessThanOrEqual(z14.length);
      for (const cells of [z3, z8, z14]) expect(sum(cells, 'offers')).toBe(6);
      const parentOf = (id: string, up: number) => {
        const [z, x, y] = id.split('/').map(Number);
        return `${z - up}/${x >> up}/${y >> up}`;
      };
      const ids8 = new Set(z8.map((c) => c.cellId));
      for (const cell of z14)
        expect(ids8.has(parentOf(cell.cellId, 6))).toBe(true);
      const ids3 = new Set(z3.map((c) => c.cellId));
      for (const cell of z8)
        expect(ids3.has(parentOf(cell.cellId, 5))).toBe(true);

      for (const zoom of ['-1', '21', '2.5', 'high', '']) {
        const res = await clusters({ zoom }).expect(400);
        expect(
          res.body.errors.map((e: { field: string }) => e.field),
        ).toContain('zoom');
      }
      for (const zoom of ['0', '20']) await clusters({ zoom }).expect(200);
      expect(
        (await cellsOf({ zoom: undefined })).cells.every((c) =>
          c.cellId.startsWith('10/'),
        ),
      ).toBe(true);
    });

    it('S19 AS-36: a product filter counts only that product; a one-point cell names its point, a many-point cell does not', async () => {
      const [a, b] = await Promise.all([
        t.product(w.s1.id),
        t.product(w.s1.id),
      ]);
      const mitte = await offer(MITTE, [a]);
      const kreuzberg = await offer(KREUZBERG, [a, b]);
      const spandau = await offer(SPANDAU, [b]);
      await t.consume();

      const onlyA = await cellsOf({ productId: a.id, zoom: '14' });
      expect(sum(onlyA.cells, 'offers')).toBe(2);
      expect(onlyA.cells.map((c) => c.pickupPointId).sort()).toEqual(
        [mitte.id, kreuzberg.id].sort(),
      );
      const onlyB = await cellsOf({ productId: b.id, zoom: '14' });
      expect(onlyB.cells.map((c) => c.pickupPointId).sort()).toEqual(
        [kreuzberg.id, spandau.id].sort(),
      );

      const merged = await cellsOf({ zoom: '3' });
      expect(merged.cells).toHaveLength(1);
      expect(merged.cells[0]).toMatchObject({ offers: 4, pickupPoints: 3 });
      expect(merged.cells[0]).not.toHaveProperty('pickupPointId');
      expect(
        (await clusters({ productId: 'abc' }).expect(400)).body.errors.map(
          (e: { field: string }) => e.field,
        ),
      ).toContain('productId');
    });

    it.each([
      ['missing', undefined],
      ['three numbers', '1,2,3'],
      ['five numbers', '1,2,3,4,5'],
      ['text', 'a,b,c,d'],
      ['a latitude above 90', '91,0,0,1'],
      ['a latitude below -90', '10,0,-91,1'],
      ['a longitude above 180', '10,0,0,181'],
      ['a longitude below -180', '10,-181,0,1'],
      ['top equal to bottom', '10,0,10,1'],
      ['top below bottom', '0,0,10,1'],
    ])(
      'S19 AS-37: a bbox that is %s answers 400 validation_failed naming bbox',
      async (_name, bbox) => {
        const res = await clusters({ bbox }).expect(400);
        expect(res.body.code).toBe('validation_failed');
        expect(
          res.body.errors.map((e: { field: string }) => e.field),
        ).toContain('bbox');
      },
    );

    it('S19 AS-37: a box that crosses the antimeridian counts the offers on both sides of ±180°', async () => {
      const a = await t.product(w.s1.id);
      await offer({ lat: -17.7, lng: 179.9 }, [a]);
      await offer({ lat: -17.7, lng: -179.9 }, [a]);
      await offer({ lat: -17.7, lng: 0.5 }, [a]); // far from the box
      await t.consume();

      const body = await cellsOf({ bbox: '0,170,-30,-170', zoom: '4' });

      expect(sum(body.cells, 'offers')).toBe(2);
      expect(sum(body.cells, 'pickupPoints')).toBe(2);
    });
  });

  describe('US5 - the cell cap', () => {
    it('S19 AS-38: more than 500 cells give the 500 with the most offers (ties by cellId) and truncated true', async () => {
      const engine = t.app.get(SearchEngineClient);
      const docs: object[] = [];
      // 600 cells at zoom 12, 0.1 degree apart; the first 100 hold two offers, the rest one
      for (let i = 0; i < 600; i++) {
        const lat = 40 + Math.floor(i / 30) * 0.1;
        const lng = 5 + (i % 30) * 0.1;
        for (let k = 0; k < (i < 100 ? 2 : 1); k++)
          docs.push({
            productId: `00000000-0000-4000-8000-${String(i * 2 + k).padStart(12, '0')}`,
            pickupPointId: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            quantity: 1,
            location: { lat, lon: lng },
          });
      }
      await engine.bulk(
        docs.flatMap((d, n) => [
          { index: { _index: AVAILABILITY_INDEX, _id: `doc-${n}` } },
          d,
        ]),
        { refresh: true },
      );
      const bbox = '46,4,39,9';
      const all = await engine.search({
        index: AVAILABILITY_INDEX,
        size: 0,
        aggs: {
          c: { geotile_grid: { field: 'location', precision: 12, size: 1000 } },
        },
      });
      const full = (
        all.aggregations.c.buckets as { key: string; doc_count: number }[]
      ).map((b) => ({ cellId: b.key, offers: b.doc_count }));
      expect(full.length).toBeGreaterThan(500);

      const body = await cellsOf({ bbox, zoom: '12' });

      expect(body.truncated).toBe(true);
      expect(body.cells).toHaveLength(500);
      const expected = [...full]
        .sort((x, y) => y.offers - x.offers || (x.cellId < y.cellId ? -1 : 1))
        .slice(0, 500)
        .map((c) => c.cellId);
      expect(body.cells.map((c) => c.cellId)).toEqual(expected);
    });
  });

  describe('US5 - caching, limits and failure', () => {
    it('S19 AS-39: a success is cacheable for 30 seconds and sets no cookie', async () => {
      const res = await clusters().expect(200);
      expect(res.headers['cache-control']).toBe('public, s-maxage=30');
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('S19 AS-39: the 301st request in a minute answers 429 rate_limited with no-store; the limiter store down fails open', async () => {
      for (let i = 0; i < 300; i++) await clusters().expect(200);
      const limited = await clusters().expect(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(limited.headers['cache-control']).toBe('no-store');

      await t.reset();
      const labels = { policy: 'fulfilment.map-clusters', fail_mode: 'open' };
      const before =
        MetricsRegistry.value('rate_limit_store_unavailable_total', labels) ??
        0;
      t.redisProxy!.mode = 'refuse';
      try {
        await clusters().expect(200);
      } finally {
        t.redisProxy!.mode = 'pass';
      }
      expect(
        MetricsRegistry.value('rate_limit_store_unavailable_total', labels) ??
          0,
      ).toBeGreaterThan(before);
    });

    it('S19 AS-39: a failing index answers 503 search_unavailable with no-store', async () => {
      t.searchProxy!.mode = 'refuse';
      let res;
      try {
        res = await clusters();
      } finally {
        t.searchProxy!.mode = 'pass';
      }
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('search_unavailable');
      expect(res.headers['cache-control']).toBe('no-store');
    });
  });
});
