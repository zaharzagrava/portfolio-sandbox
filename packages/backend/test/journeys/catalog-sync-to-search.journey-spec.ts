import { randomUUID } from 'node:crypto';
import {
  conflictPageSchema,
  pickupStockPageSchema,
  searchIndexStatusSchema,
  type ProductPage,
  type SyncChange,
} from '@marketplace-sandbox/contracts';
import { DeviceClient, uuidv7 } from './support/device-client';
import { ControlSurface, adminClient } from './support/control-surface';
import { JourneyClient, problemCode } from './support/journey-client';
import {
  inviteAndAccept,
  onboardVerified,
  openShop,
  registerSeller,
  subscribe,
} from './support/seller-fixture';
import { staysTrue, waitForContract } from './support/wait-for-contract';
import { sseClient, topics } from './support/sse-client';
import {
  csv,
  importStatus,
  listProducts,
  rowsFor,
  searchProducts,
  startAndComplete,
  startImport,
  completeImport,
  uploadParts,
  waitImportTerminal,
  zipAsCsv,
  type FixtureShop,
} from './support/catalog-fixture';
import {
  adjustPickupStock,
  createPickupPoint,
  pointsNear,
  searchNear,
  setPickupStock,
  type PickupSite,
} from './support/pickup-fixture';
import { ScannerDouble } from './support/scanner-double';
import { ShopifyDouble } from './support/shopify-double';
import {
  callback,
  connectShopify,
  disconnect,
  readIntegration,
  waitLinked,
  webhookUrl,
} from './support/shopify-fixture';

/**
 * Journey J04: catalog sync to search. Black box: public HTTP only, the control surface, and the provider doubles this
 * journey owns (Shopify, malware scanner). Every wait is a contract hop (`J04.H1`..`J04.H16`), never a sleep (L-007);
 * "nothing happens" is asserted only after the consumer reports `lag: 0` and the hop maximum has passed on the stack
 * clock (L-003). Every story creates its own shop and products (L-005, L-006). Scenario titles carry the test-plan id
 * `AS-nn` (L-017). The file is serial: consumer pauses and the clock are global state of the stack (L-029).
 */
describe('Journey J04: catalog sync to search', () => {
  /** The run token: lower-case letters and digits, so one search term finds exactly this run's products. */
  const run = `j04${Date.now().toString(36)}${randomUUID().slice(0, 4).replace(/-/g, '')}`;
  let admin: JourneyClient;
  let control: ControlSurface;
  let scanner: ScannerDouble | undefined;

  beforeAll(async () => {
    admin = await adminClient();
    control = new ControlSurface(admin);
    await control.restoreAll(); // a known stack: consumers running, clock real
    scanner = await ScannerDouble.startDouble().catch(() => undefined);
  });

  afterAll(async () => {
    await scanner?.stop();
    await control?.restoreAll({ endAdminSessions: true });
  });

  /** A verified, subscribed shop of its own (Pro plan, so the plan limit never decides a scenario). */
  const newShop = async (label: string): Promise<FixtureShop> => {
    const owner = await registerSeller(label);
    const shop = await openShop(owner);
    await onboardVerified(shop);
    const subscribed = await subscribe(shop);
    expect([200, 201]).toContain(subscribed.status);
    return { owner, shopId: shop.shopId };
  };

  const indexLag = async (): Promise<number> => {
    const reply = await admin.get('/api/admin/search/index', {
      schema: searchIndexStatusSchema,
    });
    expect(reply.status).toBe(200);
    return searchIndexStatusSchema.parse(reply.body).projectionLagSeconds;
  };

  /** The consumers have caught up with everything written so far (J04.H15). */
  const settle = async (...groups: string[]) => {
    for (const group of groups) await control.waitCaughtUp(group, 'J04.H15');
  };

  /** A product made through the seller route (no provider link, no import): the plain catalog product of a story. */
  const createCatalogProduct = async (
    s: FixtureShop,
    title: string,
    quantity: number,
  ) => {
    const created = await s.owner.post<{
      id: string;
      version: number;
      title: string;
    }>(`/api/shops/${s.shopId}/products`, {
      body: {
        title,
        brand: 'Journey',
        category: 'electronics',
        quantity,
        priceMinor: 1500,
        currency: 'EUR',
        description: `${title}. Created by the J04 journey.`,
        tags: ['journey'],
      },
      key: randomUUID(),
    });
    expect([200, 201]).toContain(created.status);
    return created.body;
  };

  /**
   * Runs `fn` with the stack clock moved past the pull interval of a freshly backfilled integration (an integration is due
   * again after 5 minutes). The clock stays moved until `fn` has seen its effects: the events written meanwhile are due on the
   * moved clock, and the relay would hold them until real time catches up if the clock went back first.
   */
  let clockMoves = 0;
  const whileClockMoved = async <T>(fn: () => Promise<T>): Promise<T> => {
    // Each move goes further than the one before: a pull that ran on the earlier moved clock scheduled the next one
    // 5 minutes (+ jitter) after that clock, which real time plus a smaller move would not reach.
    clockMoves += 1;
    await control.advance(400 + 700 * (clockMoves - 1));
    try {
      return await fn();
    } finally {
      await control.rebase();
    }
  };

  /** A shop connected to a fresh Shopify double (seven variants named after `token`), backfilled and searchable. */
  const connectedStore = async (label: string, token: string) => {
    const shop = await newShop(label);
    const double = await ShopifyDouble.startDouble();
    double.clockSkewMs = Date.parse((await control.clock()).now) - Date.now();
    const variants = double.seedStandard(token);
    const connected = await connectShopify(shop, double);
    await waitLinked(shop, connected.integrationId, 7);
    await waitForContract('J04.H3', async () => {
      const found = await searchProducts(token);
      return found.total === 7 ? found : null;
    });
    const products = await listProducts(shop);
    const productOf = (variant: number) =>
      products.find((p) => p.externalSku?.endsWith(`:${variant}`))!;
    return {
      shop,
      double,
      variants,
      integrationId: connected.integrationId,
      productOf,
      close: async () => {
        await disconnect(shop, connected.integrationId);
        await double.stop();
      },
    };
  };

  const byId = (items: ProductPage['items']) =>
    new Map(items.map((p) => [p.id, p]));

  describe('US1: a bulk file becomes a searchable catalog, exactly once', () => {
    let shop: FixtureShop;
    let other: FixtureShop;
    let token: string;
    const key = randomUUID();
    let importId: string;
    let file: string;

    beforeAll(async () => {
      shop = await newShop('us1');
      other = await newShop('us1other');
      token = `${run}a`;
      file = csv(rowsFor(token, 60, { priceCents: 1500, stock: 5 }));
    });

    it('J04 AS-01: a 60-row file becomes 60 products and 60 search documents; a late subscriber still gets the terminal event', async () => {
      const content = Buffer.from(file);
      const started = await startImport(
        shop,
        'catalog.csv',
        content.length,
        key,
      );
      importId = started.importId;
      const parts = await uploadParts(started, content);
      const completed = await completeImport(shop, importId, parts);
      expect(completed.status).toBe(202);

      // The trigger is the terminal state of the import (status or SSE), never the topic `catalog-sync.events` (S07 follow-up).
      const job = await waitImportTerminal(shop, importId);
      expect(job.status).toBe('DONE');
      expect(job.rowsCreated).toBe(60);
      expect(job.rowsFailed).toBe(0);

      // J04.H2: the products are in the catalog as soon as the import is DONE.
      const products = (await listProducts(shop)).filter((p) =>
        p.title.includes(token),
      );
      expect(products).toHaveLength(60);
      for (const p of products) {
        expect(p.externalSku).toMatch(new RegExp(`^${token}-`));
        expect(p.quantity).toBe(5);
        expect(p.priceMinor).toBe(1500);
        expect(p.version).toBe(1);
      }

      // The stream of the import replays its terminal event for a subscriber that connects after the end.
      const late = await sseClient(shop.owner, topics.import(importId));
      try {
        const done = await late.next(
          (e) => e.event === 'done' || e.data?.type === 'done',
          10_000,
          'terminal import event (done)',
        );
        expect(done).toBeDefined();
      } finally {
        late.close();
      }

      // J04.H3: the index follows.
      const found = await waitForContract('J04.H3', async () => {
        const result = await searchProducts(token);
        return result.total === 60 ? result : null;
      });
      const wanted = byId(products);
      expect(found.items).toHaveLength(60);
      for (const item of found.items) {
        expect(wanted.has(item.id)).toBe(true);
        expect(item.shopId).toBe(shop.shopId);
        expect(item.priceMinor).toBe(1500);
        expect(item.inStock).toBe(true);
      }
      // Another shop's owner finds nothing of this shop's run.
      expect(
        (await searchProducts(`${token}zzz`, { viewer: other.owner })).total,
      ).toBe(0);
    });

    it('J04 AS-02: a retried start opens the same import; a second import of the same file changes nothing', async () => {
      const again = await startImport(
        shop,
        'catalog.csv',
        Buffer.byteLength(file),
        key,
      );
      expect(again.importId).toBe(importId);
      const imports = await shop.owner.get<{ items: { id: string }[] }>(
        `/api/shops/${shop.shopId}/imports`,
      );
      expect(imports.body.items.map((i) => i.id)).toEqual([importId]);

      const before = await importStatus(shop, importId);
      const repeatedComplete = await completeImport(shop, importId, [
        { partNumber: 1, etag: 'any' },
      ]);
      expect([200, 202]).toContain(repeatedComplete.status);
      const after = await importStatus(shop, importId);
      expect(after.history).toEqual(before.history);
      expect(after.rowsCreated).toBe(before.rowsCreated);

      const lagBefore = await indexLag();
      const second = await startAndComplete(shop, 'catalog.csv', file);
      expect(second.completeStatus).toBe(202);
      const job = await waitImportTerminal(shop, second.importId);
      expect(job.status).toBe('DONE');
      expect(job.rowsUnchanged).toBe(60);
      expect(job.rowsCreated).toBe(0);
      const products = (await listProducts(shop)).filter((p) =>
        p.title.includes(token),
      );
      expect(products.every((p) => p.version === 1)).toBe(true);

      // Nothing was written, so nothing reaches the index: asserted after the consumer is at lag 0 and the hop has passed.
      await settle('search-product-index');
      await staysTrue(
        'J04.H3',
        async () => {
          expect((await searchProducts(token)).total).toBe(60);
        },
        'search total stays 60',
      );
      expect(await indexLag()).toBeLessThanOrEqual(Math.max(lagBefore, 1));
    });

    it('J04 AS-03: changed prices reach search, stock is untouched, only changed rows get a new version', async () => {
      const rows = rowsFor(token, 60, { priceCents: 1500, stock: 5 }).map(
        (r, i) => ({ ...r, price: i < 3 ? '18.00' : r.price }),
      );
      // No stock column: an absent column leaves stock alone.
      // Every other column is the same as in F1, so only the price differs.
      const text =
        'sku,title,price,category,brand,description\n' +
        rows
          .map((r) =>
            [
              r.sku,
              r.title,
              r.price,
              'electronics',
              'Journey',
              `${r.title}. Imported by the J04 journey.`,
            ].join(','),
          )
          .join('\n') +
        '\n';
      const run3 = await startAndComplete(shop, 'catalog-prices.csv', text);
      const job = await waitImportTerminal(shop, run3.importId);
      expect(job.status).toBe('DONE');
      expect(job.rowsUpdated).toBe(3);
      expect(job.rowsUnchanged).toBe(57);

      const products = (await listProducts(shop)).filter((p) =>
        p.title.includes(token),
      );
      const changed = products.filter((p) => p.priceMinor === 1800);
      expect(changed).toHaveLength(3);
      expect(changed.every((p) => p.version === 2)).toBe(true);
      expect(
        products
          .filter((p) => p.priceMinor === 1500)
          .every((p) => p.version === 1),
      ).toBe(true);
      expect(products.every((p) => p.quantity === 5)).toBe(true);

      await waitForContract('J04.H3', async () => {
        const found = await searchProducts(token);
        const prices = found.items.map((i) => i.priceMinor);
        return prices.filter((p) => p === 1800).length === 3 &&
          prices.filter((p) => p === 1500).length === 57
          ? found
          : null;
      });
    });

    it('J04 AS-04: a ZIP renamed .csv ends FAILED, writes nothing and reaches nothing', async () => {
      // Not one edit away from another token of this run: search is typo-tolerant.
      const fresh = `qzx${randomUUID().replace(/-/g, '').slice(0, 10)}`;
      const countBefore = (await listProducts(shop)).length;
      const lagBefore = await indexLag();
      const zip = zipAsCsv();
      const started = await startImport(shop, 'renamed.csv', zip.length);
      const stream = await sseClient(
        shop.owner,
        topics.import(started.importId),
      );
      try {
        const parts = await uploadParts(started, zip);
        expect(
          (await completeImport(shop, started.importId, parts)).status,
        ).toBe(202);
        const job = await waitImportTerminal(shop, started.importId);
        expect(job.status).toBe('FAILED');
        expect(job.failure?.code).toBe('unsupported_file_type');
        await stream.next(
          (e) => e.event === 'failed' || e.data?.type === 'failed',
          10_000,
          'terminal import event (failed)',
        );
      } finally {
        stream.close();
      }
      expect((await listProducts(shop)).length).toBe(countBefore);
      await settle('search-product-index');
      expect((await searchProducts(fresh)).total).toBe(0);
      expect(await indexLag()).toBeLessThanOrEqual(Math.max(lagBefore, 1));
    });
  });

  describe('US2: a Shopify store joins the catalog and stays current', () => {
    let shop: FixtureShop;
    let double: ShopifyDouble;
    let variants: Record<string, number>;
    let integrationId: string;
    let callbackQuery: string;
    let token: string;

    beforeAll(async () => {
      shop = await newShop('us2');
      token = `${run}s`;
      double = await ShopifyDouble.startDouble();
      double.clockSkewMs = Date.parse((await control.clock()).now) - Date.now();
      variants = double.seedStandard(token);
    });

    afterAll(async () => {
      if (integrationId) await disconnect(shop, integrationId);
      await double?.stop();
    });

    const productOf = async (variantId: number) => {
      const all = await listProducts(shop);
      return all.find((p) => p.externalSku?.endsWith(`:${variantId}`));
    };

    it('J04 AS-05: install, signed callback and backfill make 7 products (the draft is ignored) that search finds; a repeated callback is refused', async () => {
      const connected = await connectShopify(shop, double);
      integrationId = connected.integrationId;
      callbackQuery = connected.query;

      const view = await waitLinked(shop, integrationId, 7);
      expect(view.status).toBe('ACTIVE');

      const products = await listProducts(shop);
      expect(products).toHaveLength(7);
      const prefix = `shopify:${integrationId}:`;
      for (const p of products)
        expect(p.externalSku).toMatch(new RegExp(`^${prefix}\\d+:\\d+$`));
      for (const [, variantId] of Object.entries(variants)) {
        const p = products.find((x) =>
          x.externalSku?.endsWith(`:${variantId}`),
        );
        expect(p).toBeDefined();
        expect(p!.quantity).toBe(double.stockOf(variantId));
      }
      expect(products.some((p) => p.title.includes('Draft'))).toBe(false);

      const found = await waitForContract('J04.H3', async () => {
        const result = await searchProducts(token);
        return result.total === 7 ? result : null;
      });
      expect(found.items.every((i) => i.inStock)).toBe(true);

      // A second delivery of the same callback: one identical 400, no second integration, no second backfill.
      const again = await callback(connected.query);
      expect(again.status).toBe(400);
      expect(((await again.json()) as { code?: string }).code).toBe(
        'invalid_oauth_callback',
      );
      expect((await listProducts(shop)).length).toBe(7);
    });

    it('J04 AS-06: a signed webhook updates the product once; the same delivery and a bad signature change nothing', async () => {
      const v1 = variants.V1;
      const before = (await productOf(v1))!;
      const productId = double
        .allProducts()
        .find((p) => p.variants.some((v) => v.id === v1))!.id;
      const updated = double.updateProduct(productId, { price: '21.50' });
      const url = webhookUrl(integrationId);

      const first = await double.deliverWebhook(
        url,
        'products/update',
        updated,
        {
          webhookId: `d1-${run}`,
        },
      );
      expect(first.status).toBe(200);
      const duplicate = await double.deliverWebhook(
        url,
        'products/update',
        updated,
        {
          webhookId: `d1-${run}`,
        },
      );
      expect(duplicate.status).toBe(200);

      const after = await waitForContract('J04.H5', async () => {
        const p = await productOf(v1);
        return p && p.priceMinor === 2150 ? p : null;
      });
      expect(after.version).toBe(before.version + 1);
      await waitForContract('J04.H3', async () => {
        const found = await searchProducts(token);
        return found.items.find((i) => i.id === after.id)?.priceMinor === 2150
          ? found
          : null;
      });

      const forged = await double.deliverWebhook(
        url,
        'products/update',
        updated,
        {
          secret: 'not-the-app-secret',
          webhookId: `bad-${run}`,
        },
      );
      expect(forged.status).toBe(401);
      // The unknown integration answers like a bad signature.
      const unknown = await double.deliverWebhook(
        webhookUrl(randomUUID()),
        'products/update',
        updated,
        { webhookId: `unk-${run}` },
      );
      expect(unknown.status).toBe(401);
      await staysTrue(
        'J04.H5',
        async () => {
          expect((await productOf(v1))!.version).toBe(before.version + 1);
        },
        'the product keeps its version',
      );
    });

    it('J04 AS-07: a change at the provider without a webhook is found by the scheduled pull; a second run is a no-op', async () => {
      const v6 = variants.V6;
      const target = double
        .allProducts()
        .find((p) => p.variants.some((v) => v.id === v6))!;
      double.updateProduct(target.id, { title: `Shopify Renamed ${token}` });

      // The pull is scheduled, not immediate: an integration backfilled a moment ago is due again after 5 minutes (+ jitter).
      await control.advance(400);
      // The clock stays moved until the effects are seen: the events the pull writes are due on the moved clock, and the
      // relay would hold them until real time catches up if the clock went back first.
      let job;
      let renamed;
      try {
        job = await control.runJob('catalog-sync.sync-all');
        expect(job.status).toBe('SUCCEEDED');
        renamed = await waitForContract('J04.H6', async () => {
          const p = await productOf(v6);
          return p && p.title.includes('Renamed') ? p : null;
        });
        await waitForContract('J04.H3', async () => {
          const found = await searchProducts(token);
          return found.items
            .find((i) => i.id === renamed!.id)
            ?.title.includes('Renamed')
            ? found
            : null;
        });
      } finally {
        await control.rebase();
      }
      const view = await readIntegration(shop, integrationId);
      expect(view.lastSyncAt).not.toBeNull();
      expect(view.lagSeconds).not.toBeNull();
      expect(view.lagSeconds!).toBeLessThan(600);

      const again = await control.runJob('catalog-sync.sync-all');
      expect(again.status).toBe('SUCCEEDED');
      expect((await productOf(v6))!.version).toBe(renamed.version);
    });
  });

  describe('US3: a stocked product is available near me, and stays consistent with the catalog', () => {
    let shop: FixtureShop;
    let other: FixtureShop;
    let token: string;
    let site: PickupSite;
    let product: { id: string; version: number; title: string };

    const nearOffer = async (title?: string, quantity?: number) =>
      waitForContract('J04.H7', async () => {
        const found = (await searchNear(site, token)).find(
          (i) =>
            i.productId === product.id &&
            (title === undefined || i.title === title) &&
            (quantity === undefined || i.nearest.quantity === quantity),
        );
        return found ?? null;
      });

    beforeAll(async () => {
      shop = await newShop('us3');
      other = await newShop('us3other');
      token = `${run}c`;
      site = await createPickupPoint(shop);
      product = await createCatalogProduct(shop, `Lamp ${token} 001`, 5);
    });

    it('J04 AS-08: stocking a pickup point makes the product appear near me with the catalog title and price; another shop’s product cannot be stocked', async () => {
      expect(await searchNear(site, token)).toEqual([]);

      const stocked = await setPickupStock(site, product.id, 4);
      expect(stocked.status).toBe(200);
      const offer = await nearOffer();
      expect(offer.title).toBe(`Lamp ${token} 001`);
      expect(offer.priceMinor).toBe(1500);
      expect(offer.nearest.pickupPointId).toBe(site.point.id);
      expect(offer.nearest.quantity).toBe(4);
      expect(offer.nearest.distanceM).toBeGreaterThan(1000);
      expect(offer.nearest.distanceM).toBeLessThan(1400);
      expect((await searchNear(site, token)).map((i) => i.productId)).toEqual([
        product.id,
      ]);
      const exact = await pointsNear(site, product.id);
      expect(exact.map((p) => [p.id, p.quantity])).toEqual([
        [site.point.id, 4],
      ]);

      // A product of another shop cannot be put on this shop's shelf; nothing is written.
      const foreign = await createCatalogProduct(other, `Lamp ${token} 002`, 5);
      const refused = await setPickupStock(site, foreign.id, 2);
      expect(refused.status).toBe(404);
      expect((refused.body as { code?: string }).code).toBe(
        'product_not_found',
      );
    });

    it('J04 AS-09: title, price, archive and restore of the catalog product reach near-me and search; an adjustment with a key applies once', async () => {
      const renamed = `Lamp ${token} 001 XL`;
      const patched = await shop.owner.call<{ version: number }>(
        'PATCH',
        `/api/shops/${shop.shopId}/products/${product.id}`,
        {
          body: {
            expectedVersion: product.version,
            title: renamed,
            priceMinor: 1700,
          },
        },
      );
      expect(patched.status).toBe(200);
      let version = patched.body.version;
      const updated = await nearOffer(renamed);
      expect(updated.priceMinor).toBe(1700);
      await waitForContract('J04.H3', async () => {
        const found = await searchProducts(token);
        const doc = found.items.find((i) => i.id === product.id);
        return doc?.title === renamed && doc.priceMinor === 1700 ? doc : null;
      });

      const archived = await shop.owner.post<{ version: number }>(
        `/api/shops/${shop.shopId}/products/${product.id}/archive`,
        { body: { expectedVersion: version } },
      );
      expect(archived.status).toBe(200);
      version = archived.body.version;
      await waitForContract('J04.H8', async () =>
        (await searchNear(site, token)).some((i) => i.productId === product.id)
          ? null
          : true,
      );
      await waitForContract('J04.H3', async () =>
        (await searchProducts(token)).items.some((i) => i.id === product.id)
          ? null
          : true,
      );
      // S19.R-14: one visibility rule decides the index and the exact browse, so the browse hides the archived product too.
      expect(await pointsNear(site, product.id)).toEqual([]);

      const restored = await shop.owner.post<{ version: number }>(
        `/api/shops/${shop.shopId}/products/${product.id}/restore`,
        { body: { expectedVersion: version } },
      );
      expect(restored.status).toBe(200);
      const back = await nearOffer(renamed, 4); // the shelf count was never touched
      expect(back.priceMinor).toBe(1700);
      expect((await pointsNear(site, product.id)).map((p) => p.id)).toEqual([
        site.point.id,
      ]);
      await waitForContract('J04.H3', async () =>
        (await searchProducts(token)).items.some((i) => i.id === product.id)
          ? true
          : null,
      );

      // One adjustment with a key applies once, however often it is sent.
      const key = randomUUID();
      const first = await adjustPickupStock(site, product.id, -1, key);
      expect(first.status).toBe(200);
      const again = await adjustPickupStock(site, product.id, -1, key);
      expect(again.status).toBe(200);
      await nearOffer(renamed, 3);
      await settle('pickup-availability');
      expect((await nearOffer(renamed)).nearest.quantity).toBe(3);
    });
  });

  describe('US4: an offline device sells stock and every copy follows', () => {
    let shop: FixtureShop;
    let double: ShopifyDouble;
    let variants: Record<string, number>;
    let integrationId: string;
    let token: string;
    let d1: DeviceClient;
    let d2: DeviceClient;
    let ps: ProductPage['items'][number]; // linked to V1, quantity 10
    let pc: { id: string; version: number; title: string }; // a plain catalog product, quantity 5
    let site: PickupSite;
    let sale1Version: number;

    const productById = async (id: string) =>
      (await listProducts(shop)).find((p) => p.id === id)!;
    const writesOf = (variantId: number) =>
      double.writeLog.filter((w) => w.variantId === variantId);
    const searchDoc = async (id: string) =>
      (await searchProducts(token)).items.find((i) => i.id === id);
    /** Pulls until the feed is drained and returns every change seen. */
    const drain = async (device: DeviceClient) => {
      const seen: SyncChange[] = [];
      for (;;) {
        const page = await device.pull(200);
        expect(page.status).toBe(200);
        seen.push(...page.body.changes);
        if (!page.body.hasMore) return seen;
      }
    };

    beforeAll(async () => {
      shop = await newShop('us4');
      token = `${run}d`;
      double = await ShopifyDouble.startDouble();
      double.clockSkewMs = Date.parse((await control.clock()).now) - Date.now();
      variants = double.seedStandard(token);
      const connected = await connectShopify(shop, double);
      integrationId = connected.integrationId;
      await waitLinked(shop, integrationId, 7);
      await waitForContract('J04.H3', async () => {
        const found = await searchProducts(token);
        return found.total === 7 ? found : null;
      });
      ps = (await listProducts(shop)).find((p) =>
        p.externalSku?.endsWith(`:${variants.V1}`),
      )!;
      expect(ps.quantity).toBe(10);
      pc = await createCatalogProduct(shop, `Lamp ${token} 001`, 5);
      site = await createPickupPoint(shop);
      expect((await setPickupStock(site, pc.id, 4)).status).toBe(200);
      d1 = new DeviceClient(shop, `d1-${run}`);
      d2 = new DeviceClient(shop, `d2-${run}`);
      await drain(d2); // D2 stands at the cursor "before the sale" (C0)
      await settle('integrations-stock-push', 'offline-sync-feed');
    });

    afterAll(async () => {
      if (integrationId) await disconnect(shop, integrationId);
      await double?.stop();
    });

    it('J04 AS-10: a sale pushed by a device lowers the catalog once, reaches search and is written to Shopify once, and the echo changes nothing', async () => {
      const pushed = await d1.push([d1.sale(ps.id, 3)]);
      expect(pushed.status).toBe(200);
      const result = pushed.body.results[0];
      expect(result).toMatchObject({
        status: 'applied',
        replayed: false,
        quantityAfter: 7,
      });
      sale1Version = result.productVersion!;
      expect(sale1Version).toBe(ps.version + 1);
      expect((await productById(ps.id)).quantity).toBe(7);

      const doc = await waitForContract('J04.H10', async () => {
        const d = await searchDoc(ps.id);
        return d?.inStock ? d : null;
      });
      expect(doc.inStock).toBe(true);

      await waitForContract('J04.H11', async () =>
        writesOf(variants.V1).length === 1 ? true : null,
      );
      expect(writesOf(variants.V1)).toEqual([
        { variantId: variants.V1, set: 7, expected: 10 },
      ]);

      // The echo: the next pull of the provider sees 7 = base 7 = local 7 and changes nothing (no ping-pong). The clock stays
      // moved until the end of the observation: the events of the pull are due on the moved clock.
      await control.advance(400);
      try {
        const job = await control.runJob('catalog-sync.sync-all');
        expect(job.status).toBe('SUCCEEDED');
        await settle('integrations-stock-push', 'search-product-index');
        await staysTrue(
          'J04.H13',
          async () => {
            expect(writesOf(variants.V1)).toHaveLength(1);
            expect((await productById(ps.id)).version).toBe(sale1Version);
          },
          'the echo changes nothing',
        );
      } finally {
        await control.rebase();
      }
    });

    it('J04 AS-11: the same operation again does nothing; a changed body is refused; selling out sets inStock false and zeroes Shopify', async () => {
      // A till that timed out resends the very same operation (same opId, same body, same clock reading).
      const op = d1.sale(ps.id, 1, uuidv7());
      const opId = op.opId;
      const first = await d1.push([op]);
      expect(first.body.results[0]).toMatchObject({
        status: 'applied',
        replayed: false,
      });
      const replay = await d1.push([op]);
      expect(replay.body.results[0]).toMatchObject({
        status: 'applied',
        replayed: true,
        quantityAfter: 6,
      });
      const changed = await d1.push([d1.sale(ps.id, 2, opId)]);
      expect(changed.body.results[0]).toMatchObject({
        status: 'rejected',
        code: 'op_id_reused',
      });
      const afterReplay = await productById(ps.id);
      expect(afterReplay.quantity).toBe(6);
      expect(afterReplay.version).toBe(sale1Version + 1);
      await waitForContract('J04.H11', async () =>
        writesOf(variants.V1).length === 2 ? true : null,
      );
      await settle('integrations-stock-push');
      await staysTrue(
        'J04.H11',
        async () => expect(writesOf(variants.V1)).toHaveLength(2),
        'the replay causes no second write',
      );

      const sold = await d1.push([d1.sale(ps.id, 6)]);
      expect(sold.body.results[0]).toMatchObject({
        status: 'applied',
        quantityAfter: 0,
      });
      await waitForContract('J04.H10', async () => {
        const d = await searchDoc(ps.id);
        return d && !d.inStock ? d : null;
      });
      await waitForContract('J04.H11', async () =>
        writesOf(variants.V1).length === 3 ? true : null,
      );
      expect(writesOf(variants.V1)[2]).toEqual({
        variantId: variants.V1,
        set: 0,
        expected: 6,
      });
      expect(double.stockOf(variants.V1)).toBe(0);
    });

    it('J04 AS-12: a sale of a plain catalog product never calls Shopify and leaves the pickup count alone; the pickup count moves only by its own route', async () => {
      const writesBefore = double.writeLog.length;
      const pushed = await d1.push([d1.sale(pc.id, 1)]);
      expect(pushed.body.results[0]).toMatchObject({
        status: 'applied',
        quantityAfter: 4,
      });
      await waitForContract('J04.H10', async () => {
        const d = await searchDoc(pc.id);
        return d?.inStock ? d : null;
      });
      await settle('integrations-stock-push');
      await staysTrue(
        'J04.H11',
        async () => expect(double.writeLog).toHaveLength(writesBefore),
        'no Shopify write for an unlinked product',
      );

      const offer = (await searchNear(site, token)).find(
        (i) => i.productId === pc.id,
      );
      expect(offer?.nearest.quantity).toBe(4);
      const shelf = await shop.owner.get(
        `/api/shops/${shop.shopId}/pickup-points/${site.point.id}/stock`,
        { schema: pickupStockPageSchema },
      );
      expect(
        shelf.body.items.find((r) => r.productId === pc.id)?.quantity,
      ).toBe(4);

      const k2 = randomUUID();
      expect((await adjustPickupStock(site, pc.id, -1, k2)).status).toBe(200);
      await waitForContract('J04.H7', async () =>
        (await searchNear(site, token)).find((i) => i.productId === pc.id)
          ?.nearest.quantity === 3
          ? true
          : null,
      );
      const again = await adjustPickupStock(site, pc.id, -1, k2);
      expect(again.status).toBe(200);
      expect(again.headers.get('idempotency-replayed')).toBe('true');
      const different = await adjustPickupStock(site, pc.id, -2, k2);
      expect(different.status).toBe(422);
      await settle('pickup-availability');
      expect(
        (await searchNear(site, token)).find((i) => i.productId === pc.id)
          ?.nearest.quantity,
      ).toBe(3);
    });

    it('J04 AS-13: another device pulls the sales in order, gap-free', async () => {
      const changes: SyncChange[] = [];
      await waitForContract('J04.H12', async () => {
        changes.push(...(await drain(d2)));
        return changes.some((c) => c.id === ps.id && c.data?.quantity === 0)
          ? true
          : null;
      });
      const quantities = changes
        .filter((c) => c.id === ps.id)
        .map((c) => c.data?.quantity);
      expect(quantities[quantities.length - 1]).toBe(0);
      expect(quantities).toContain(7);
      expect(quantities.indexOf(7)).toBeLessThan(quantities.lastIndexOf(0));
      const seqs = changes.map((c) => c.seq);
      for (let i = 1; i < seqs.length; i++)
        expect(seqs[i]).toBe(seqs[i - 1] + 1);
      // The product written by D1 is not duplicated by an import or Shopify write of the same product.
      expect(
        (await listProducts(shop)).filter((p) => p.id === ps.id),
      ).toHaveLength(1);
    });
  });

  describe('US5: both sides sell, the provider is down: stock converges and nothing is lost', () => {
    let store: Awaited<ReturnType<typeof connectedStore>>;
    let token: string;
    let d1: DeviceClient;

    const quantityOf = async (productId: string) =>
      (await listProducts(store.shop)).find((p) => p.id === productId)!
        .quantity;
    const conflicts = async (status?: 'OPEN' | 'DISMISSED') => {
      const reply = await store.shop.owner.get(
        `/api/shops/${store.shop.shopId}/integrations/${store.integrationId}/conflicts`,
        { query: { status }, schema: conflictPageSchema },
      );
      expect(reply.status).toBe(200);
      return reply.body.items;
    };

    beforeAll(async () => {
      token = `${run}e`;
      store = await connectedStore('us5', token);
      d1 = new DeviceClient(store.shop, `d1-${run}`);
      await settle('integrations-stock-push');
    });

    afterAll(async () => {
      await control.resume('integrations-stock-push').catch(() => undefined);
      store?.double.answer(200);
      await store?.close();
    });

    it('J04 AS-14: a sale in the store and one at Shopify converge to local + remote − base on both sides, in either order', async () => {
      const { double, variants, productOf } = store;

      // Order 1: the till sells 2 while the push consumer is down, Shopify sells 3 meanwhile; the push finds 7, not 10.
      const a = productOf(variants.V1); // 10
      await control.pause('integrations-stock-push');
      try {
        const pushed = await d1.push([d1.sale(a.id, 2)]);
        expect(pushed.body.results[0]).toMatchObject({
          status: 'applied',
          quantityAfter: 8,
        });
        double.sell(variants.V1, 3);
      } finally {
        await control.resume('integrations-stock-push');
      }
      await waitForContract('J04.H13', async () =>
        (await quantityOf(a.id)) === 5 && double.stockOf(variants.V1) === 5
          ? true
          : null,
      );
      expect(
        double.writeLog.filter((w) => w.variantId === variants.V1).pop(),
      ).toEqual({
        variantId: variants.V1,
        set: 5,
        expected: 7,
      });
      await waitForContract('J04.H10', async () =>
        (await searchProducts(token)).items.find((i) => i.id === a.id)?.inStock
          ? true
          : null,
      );
      expect(await conflicts()).toEqual([]);

      // Order 2: the pull is applied first; the end state is the same.
      const b = productOf(variants.V2); // 5
      await control.pause('integrations-stock-push');
      try {
        const pushed = await d1.push([d1.sale(b.id, 1)]);
        expect(pushed.body.results[0]).toMatchObject({
          status: 'applied',
          quantityAfter: 4,
        });
        double.sell(variants.V2, 2);
        await whileClockMoved(async () => {
          const job = await control.runJob('catalog-sync.sync-all');
          expect(job.status).toBe('SUCCEEDED');
          await control.resume('integrations-stock-push');
          await waitForContract('J04.H13', async () =>
            (await quantityOf(b.id)) === 2 && double.stockOf(variants.V2) === 2
              ? true
              : null,
          );
        });
      } finally {
        await control.resume('integrations-stock-push');
      }
      await settle('integrations-stock-push');
      expect(await quantityOf(b.id)).toBe(2);
      expect(double.stockOf(variants.V2)).toBe(2);
      expect(await conflicts()).toEqual([]);
    });

    it('J04 AS-15: an oversold product is clamped to 0 on both sides and opens exactly one conflict that dismissing does not undo', async () => {
      const { double, variants, productOf } = store;
      const pe = productOf(variants.V5); // 3
      await control.pause('integrations-stock-push');
      try {
        const pushed = await d1.push([d1.sale(pe.id, 3)]);
        expect(pushed.body.results[0]).toMatchObject({
          status: 'applied',
          quantityAfter: 0,
        });
        double.sell(variants.V5, 2);
      } finally {
        await control.resume('integrations-stock-push');
      }
      const open = await waitForContract('J04.H13', async () => {
        const list = await conflicts('OPEN');
        return list.length === 1 ? list : null;
      });
      expect(open[0]).toMatchObject({
        kind: 'oversold',
        productId: pe.id,
        base: 3,
        local: 0,
        remote: 1,
        merged: -2,
        resolvedTo: 0,
        status: 'OPEN',
      });
      await waitForContract('J04.H11', async () =>
        double.stockOf(variants.V5) === 0 ? true : null,
      );
      expect(await quantityOf(pe.id)).toBe(0);
      await waitForContract('J04.H10', async () => {
        const d = (await searchProducts(token)).items.find(
          (i) => i.id === pe.id,
        );
        return d && !d.inStock ? d : null;
      });
      const view = await readIntegration(store.shop, store.integrationId);
      expect(view.openConflicts).toBe(1);

      // The same merge again opens no second conflict.
      await whileClockMoved(async () => {
        const job = await control.runJob('catalog-sync.sync-all');
        expect(job.status).toBe('SUCCEEDED');
        await settle('integrations-stock-push');
        await staysTrue(
          'J04.H13',
          async () => expect(await conflicts('OPEN')).toHaveLength(1),
          'no second conflict',
        );
      });

      const dismissed = await store.shop.owner.post(
        `/api/shops/${store.shop.shopId}/integrations/${store.integrationId}/conflicts/${open[0].id}/dismiss`,
      );
      expect(dismissed.status).toBe(200);
      expect(await conflicts('OPEN')).toEqual([]);
      expect(await quantityOf(pe.id)).toBe(0);
      expect(double.stockOf(variants.V5)).toBe(0);
    });

    it('J04 AS-16: with Shopify down the sale is accepted at once; the next trigger repairs Shopify without reversing the sale', async () => {
      const { double, variants, productOf } = store;
      const pf = productOf(variants.V7); // 9
      double.answer(503);
      const pushed = await d1.push([d1.sale(pf.id, 2)]);
      expect(pushed.body.results[0]).toMatchObject({
        status: 'applied',
        quantityAfter: 7,
      });
      const versionAfterSale = pushed.body.results[0].productVersion!;
      expect(await quantityOf(pf.id)).toBe(7);
      await waitForContract('J04.H10', async () => {
        const d = (await searchProducts(token)).items.find(
          (i) => i.id === pf.id,
        );
        return d?.inStock ? d : null;
      });

      const failing = await waitForContract('J04.H11', async () => {
        const view = await readIntegration(store.shop, store.integrationId);
        return view.lastError ? view : null;
      });
      expect(failing.lastError).toBeTruthy();
      expect(double.stockOf(variants.V7)).toBe(9);

      double.answer(200);
      await whileClockMoved(async () => {
        const job = await control.runJob('catalog-sync.sync-all');
        expect(job.status).toBe('SUCCEEDED');
        await waitForContract('J04.H11', async () =>
          double.stockOf(variants.V7) === 7 ? true : null,
        );
      });
      const repaired = await waitForContract('J04.H11', async () => {
        const view = await readIntegration(store.shop, store.integrationId);
        return view.lastError === null ? view : null;
      });
      expect(repaired.lastError).toBeNull();
      expect(await quantityOf(pf.id)).toBe(7);
      expect(
        (await listProducts(store.shop)).find((p) => p.id === pf.id)!.version,
      ).toBe(versionAfterSale);
    });
  });

  describe('US6: a consumer that is down, duplicate and out-of-order deliveries', () => {
    let store: Awaited<ReturnType<typeof connectedStore>>;
    let token: string;
    let d1: DeviceClient;
    let site: PickupSite;
    let startedAt: Date;

    const drainAll = async (device: DeviceClient) => {
      const seen: SyncChange[] = [];
      for (;;) {
        const page = await device.pull(200);
        expect(page.status).toBe(200);
        seen.push(...page.body.changes);
        if (!page.body.hasMore) return seen;
      }
    };
    const byIdKey = <T extends { id: string }>(a: T, b: T) =>
      a.id.localeCompare(b.id);
    /** Every observable of the story that a replay must leave as it was. */
    const snapshot = async () => ({
      search: (await searchProducts(token)).items
        .map((i) => ({
          id: i.id,
          title: i.title,
          priceMinor: i.priceMinor,
          inStock: i.inStock,
        }))
        .sort(byIdKey),
      products: (await listProducts(store.shop))
        .map((p) => ({ id: p.id, quantity: p.quantity, version: p.version }))
        .sort(byIdKey),
      near: (await searchNear(site, token))
        .map((i) => ({
          id: i.productId,
          title: i.title,
          quantity: i.nearest.quantity,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      writes: store.double.writeLog,
      feed: (
        await drainAll(new DeviceClient(store.shop, `snap-${randomUUID()}`))
      ).map((c) => ({
        seq: c.seq,
        id: c.id,
        version: c.version,
        quantity: c.data?.quantity,
      })),
    });
    const writesOf = (variantId: number) =>
      store.double.writeLog.filter((w) => w.variantId === variantId);

    beforeAll(async () => {
      startedAt = new Date(Date.now() - 60_000);
      token = `${run}f`;
      store = await connectedStore('us6', token);
      d1 = new DeviceClient(store.shop, `d1-${run}`);
      const plain = await createCatalogProduct(
        store.shop,
        `Lamp ${token} 001`,
        5,
      );
      site = await createPickupPoint(store.shop);
      expect((await setPickupStock(site, plain.id, 4)).status).toBe(200);
      await settle(
        'integrations-stock-push',
        'search-product-index',
        'pickup-availability',
        'offline-sync-feed',
      );
    });

    afterAll(async () => {
      await control.resume('search-product-index').catch(() => undefined);
      await control.resume('integrations-stock-push').catch(() => undefined);
      await store?.close();
    });

    it('J04 AS-17: with the search consumer down the stale state is visible, then the catch-up converges', async () => {
      const pg = store.productOf(store.variants.V4); // 7
      await control.pause('search-product-index');
      try {
        const sold = await d1.push([d1.sale(pg.id, 7)]);
        expect(sold.body.results[0]).toMatchObject({
          status: 'applied',
          quantityAfter: 0,
        });
        expect(
          (await listProducts(store.shop)).find((p) => p.id === pg.id)!
            .quantity,
        ).toBe(0);
        await waitForContract('J04.H11', async () =>
          store.double.stockOf(store.variants.V4) === 0 ? true : null,
        );

        // Eventual consistency is visible: the other consumers moved on, search did not.
        await staysTrue(
          'J04.H10',
          async () => {
            const doc = (await searchProducts(token)).items.find(
              (i) => i.id === pg.id,
            );
            expect(doc?.inStock).toBe(true);
          },
          'search still shows the old availability',
        );
        expect(await control.lag('search-product-index')).toBeGreaterThan(0);
        expect(await indexLag()).toBeGreaterThan(0);
      } finally {
        await control.resume('search-product-index');
      }
      await control.waitCaughtUp('search-product-index', 'J04.H15');
      await waitForContract('J04.H10', async () => {
        const doc = (await searchProducts(token)).items.find(
          (i) => i.id === pg.id,
        );
        return doc && !doc.inStock ? doc : null;
      });
      await waitForContract('J04.H15', async () =>
        (await indexLag()) < 5 ? true : null,
      );
    });

    it('J04 AS-18: with the push consumer down a burst of three sales becomes one write', async () => {
      const ph = store.productOf(store.variants.V1); // 10
      await control.pause('integrations-stock-push');
      try {
        for (const quantity of [1, 1, 2]) {
          const sold = await d1.push([d1.sale(ph.id, quantity)]);
          expect(sold.body.results[0].status).toBe('applied');
        }
        expect(
          (await listProducts(store.shop)).find((p) => p.id === ph.id)!
            .quantity,
        ).toBe(6);
        await staysTrue(
          'J04.H11',
          async () => expect(writesOf(store.variants.V1)).toEqual([]),
          'nothing is written to Shopify while the push consumer is down',
        );
      } finally {
        await control.resume('integrations-stock-push');
      }
      await control.waitCaughtUp('integrations-stock-push', 'J04.H15');
      await waitForContract('J04.H11', async () =>
        store.double.stockOf(store.variants.V1) === 6 ? true : null,
      );
      expect(writesOf(store.variants.V1)).toEqual([
        { variantId: store.variants.V1, set: 6, expected: 10 },
      ]);
    });

    it('J04 AS-19: replaying the product, pickup and tenancy events changes no observable and writes nothing to Shopify', async () => {
      const before = await snapshot();
      expect(before.search).toHaveLength(8);
      expect(before.writes.length).toBeGreaterThanOrEqual(2);

      const groups = [
        'search-product-index',
        'pickup-availability',
        'offline-sync-feed',
        'integrations-stock-push',
        'product-cache-invalidator',
      ];
      for (const group of groups) await control.replay(group, startedAt);
      for (const group of groups) await control.waitCaughtUp(group, 'J04.H15');
      await staysTrue(
        'J04.H15',
        async () => expect(await snapshot()).toEqual(before),
        'every observable is identical after the replay',
      );
    });
  });

  describe('US7: the boundaries hold: shop lifecycle, tenant isolation, one writer', () => {
    let store: Awaited<ReturnType<typeof connectedStore>>;
    let other: FixtureShop;
    let token: string;
    let d1: DeviceClient;
    let site: PickupSite;
    let plain: { id: string; version: number; title: string };

    const quantityOf = async (productId: string) =>
      (await listProducts(store.shop)).find((p) => p.id === productId)!
        .quantity;
    const visibleInSearch = async () => (await searchProducts(token)).total;

    beforeAll(async () => {
      token = `${run}g`;
      store = await connectedStore('us7', token);
      other = await newShop('us7other');
      d1 = new DeviceClient(store.shop, `d1-${run}`);
      plain = await createCatalogProduct(store.shop, `Lamp ${token} 001`, 5);
      site = await createPickupPoint(store.shop);
      expect((await setPickupStock(site, plain.id, 4)).status).toBe(200);
      await waitForContract('J04.H7', async () =>
        (await searchNear(site, token)).length === 1 ? true : null,
      );
      await waitForContract('J04.H3', async () =>
        (await visibleInSearch()) === 8 ? true : null,
      );
      await settle('integrations-stock-push', 'offline-sync-feed');
    });

    afterAll(async () => {
      await admin
        .post(`/api/admin/shops/${store?.shop.shopId}/reinstate`, {
          body: { reason: 'journey cleanup' },
        })
        .catch(() => undefined);
      await store?.close();
    });

    it('J04 AS-20: a suspended shop disappears from search and near-me and stops importing, selling and syncing; reinstating repairs it', async () => {
      const { double, variants, productOf, shop } = store;
      const psale = productOf(variants.V2);
      const suspended = await admin.post(
        `/api/admin/shops/${shop.shopId}/suspend`,
        {
          body: { reason: 'J04 check' },
        },
      );
      expect(suspended.status).toBeLessThan(300);
      try {
        await waitForContract('J04.H14', async () =>
          (await visibleInSearch()) === 0 &&
          (await searchNear(site, token)).length === 0
            ? true
            : null,
        );

        // An import started now is refused (or ends FAILED) and writes nothing.
        const importsOf = async () =>
          (
            await shop.owner.get<{ items: unknown[] }>(
              `/api/shops/${shop.shopId}/imports`,
            )
          ).body.items.length;
        const importsBefore = await importsOf();
        const file = csv(rowsFor(`${token}i`, 3));
        const refused = await shop.owner.post(
          `/api/shops/${shop.shopId}/imports`,
          {
            body: {
              fileName: 'suspended.csv',
              sizeBytes: Buffer.byteLength(file),
            },
            key: randomUUID(),
          },
        );
        expect(refused.status).toBe(403);
        expect(problemCode(refused.body)).toBe('shop_suspended');
        expect(await importsOf()).toBe(importsBefore);

        // A till sale is refused with the shop-status problem and writes nothing (the shop's product reads are refused too).
        const pushed = await d1.push([d1.sale(psale.id, 1)]);
        expect(pushed.status).toBe(403);
        expect(problemCode(pushed.body)).toBe('shop_suspended');
        expect(
          (await shop.owner.get(`/api/shops/${shop.shopId}/products`)).status,
        ).toBe(403);

        // The sync job skips the integration: no pull (lastSyncAt stays) and no call to Shopify, although Shopify has a
        // change waiting.
        double.sell(variants.V2, 1);
        const calls = double.requests.length;
        await whileClockMoved(async () => {
          const job = await control.runJob('catalog-sync.sync-all');
          expect(job.status).toBe('SUCCEEDED');
          await staysTrue(
            'J04.H6',
            async () => {
              // Not one request of any kind reaches the provider: no pull, no write.
              expect(double.requests).toHaveLength(calls);
            },
            'a suspended shop does not sync',
          );
        });
      } finally {
        const back = await admin.post(
          `/api/admin/shops/${shop.shopId}/reinstate`,
          {
            body: { reason: 'J04 check done' },
          },
        );
        expect(back.status).toBeLessThan(300);
      }

      await waitForContract('J04.H14', async () =>
        (await visibleInSearch()) === 8 &&
        (await searchNear(site, token)).length === 1
          ? true
          : null,
      );
      // The change Shopify accumulated meanwhile is applied once by the next run.
      await whileClockMoved(async () => {
        const job = await control.runJob('catalog-sync.sync-all');
        expect(job.status).toBe('SUCCEEDED');
        await waitForContract(
          'J04.H6',
          async () => ((await quantityOf(psale.id)) === 4 ? true : null), // 5 − the one unit Shopify sold meanwhile
        );
      });
    });

    it('J04 AS-21: the owner of another shop reaches none of this shop’s imports, integrations, sync or products', async () => {
      const { shop, double } = store;
      const listed = await shop.owner.get<{
        items: { id?: string; importId?: string }[];
      }>(`/api/shops/${shop.shopId}/imports`);
      const importId =
        listed.body.items?.[0]?.importId ??
        listed.body.items?.[0]?.id ??
        randomUUID();
      const foreign = [
        other.owner.get(`/api/shops/${shop.shopId}/imports/${importId}`),
        other.owner.post(`/api/shops/${shop.shopId}/imports`, {
          body: { fileName: 'x.csv', sizeBytes: 10 },
          key: randomUUID(),
        }),
        other.owner.get(`/api/shops/${shop.shopId}/integrations`),
        other.owner.post(`/api/shops/${shop.shopId}/sync/push`, {
          body: { ops: [d1.sale(plain.id, 1)] },
          headers: { 'x-device-id': `x-${run}` },
        }),
      ];
      for (const reply of await Promise.all(foreign)) {
        expect([403, 404]).toContain(reply.status);
        // `instance` repeats the path the caller itself sent; nothing else may name the shop or its resources.
        const { instance: _echo, ...rest } = (reply.body ?? {}) as Record<
          string,
          unknown
        >;
        const text = JSON.stringify(rest);
        expect(text).not.toContain(shop.shopId);
        expect(text).not.toContain(plain.id);
      }
      const otherSite = await createPickupPoint(other);
      const stocked = await setPickupStock(otherSite, plain.id, 2);
      expect([403, 404]).toContain(stocked.status);
      expect(JSON.stringify(stocked.body)).not.toContain(shop.shopId);

      // Nothing happened, and the owner's own reads are unaffected.
      expect(await quantityOf(plain.id)).toBe(5);
      const mine = await shop.owner.get(
        `/api/shops/${shop.shopId}/integrations`,
      );
      expect(mine.status).toBe(200);
      const writes = double.writeLog.length;
      await staysTrue(
        'J04.H11',
        async () => expect(double.writeLog).toHaveLength(writes),
        'no Shopify write from a foreign request',
      );
    });

    it('J04 AS-22: every writer raises the product version by exactly one per accepted change; a change that changes nothing raises none', async () => {
      const { shop, double, variants } = store;
      const versionOf = async (productId: string) =>
        (await listProducts(shop)).find((p) => p.id === productId)!.version;

      // A file product: import, changed re-import, seller edit, till sale, unchanged re-import.
      const sku = `${token}j`;
      const rows = rowsFor(sku, 1, { priceCents: 1000, stock: 5 });
      const imported = async (content: string) => {
        const { importId } = await startAndComplete(shop, 'one.csv', content);
        const job = await waitImportTerminal(shop, importId);
        expect(job.status).toBe('DONE');
      };
      await imported(csv(rows));
      const file = (await listProducts(shop)).find(
        (p) => p.externalSku === rows[0].sku,
      )!;
      expect(file.version).toBe(1);
      await imported(csv(rowsFor(sku, 1, { priceCents: 1100, stock: 5 })));
      await waitForContract('J04.H2', async () =>
        (await versionOf(file.id)) === 2 ? true : null,
      );
      const patched = await shop.owner.call<{ version: number }>(
        'PATCH',
        `/api/shops/${shop.shopId}/products/${file.id}`,
        { body: { expectedVersion: 2, title: `Renamed ${sku}` } },
      );
      expect(patched.status).toBe(200);
      expect(patched.body.version).toBe(3);
      const sold = await d1.push([d1.sale(file.id, 1)]);
      expect(sold.body.results[0]).toMatchObject({
        status: 'applied',
        productVersion: 4,
      });
      await imported(
        csv(
          rowsFor(sku, 1, { priceCents: 1100, stock: 5, title: 'Import Item' }),
        ),
      );
      // The unchanged-price re-import leaves the renamed, sold product's version as it is (title differs only in the file).
      const settled = await versionOf(file.id);
      expect(settled).toBeGreaterThanOrEqual(4);
      await settle('search-product-index');
      await waitForContract('J04.H3', async () => {
        const doc = (await searchProducts(sku)).items.find(
          (i) => i.id === file.id,
        );
        return doc?.priceMinor === 1100 ? doc : null;
      });

      // A Shopify product: provider change, till sale, seller edit, then an echo that changes nothing.
      const sp = store.productOf(variants.V6);
      const startVersion = await versionOf(sp.id);
      const remote = double
        .allProducts()
        .find((p) => p.variants.some((v) => v.id === variants.V6))!;
      double.updateProduct(remote.id, { title: `Shopify Again ${token}` });
      await whileClockMoved(async () => {
        const job = await control.runJob('catalog-sync.sync-all');
        expect(job.status).toBe('SUCCEEDED');
        await waitForContract('J04.H6', async () =>
          (await versionOf(sp.id)) === startVersion + 1 ? true : null,
        );
        const sale = await d1.push([d1.sale(sp.id, 1)]);
        expect(sale.body.results[0].productVersion).toBe(startVersion + 2);
        const edit = await shop.owner.call<{ version: number }>(
          'PATCH',
          `/api/shops/${shop.shopId}/products/${sp.id}`,
          { body: { expectedVersion: startVersion + 2, priceMinor: 777 } },
        );
        expect(edit.body.version).toBe(startVersion + 3);
        await settle('integrations-stock-push');
        const job2 = await control.runJob('catalog-sync.sync-all');
        expect(job2.status).toBe('SUCCEEDED');
        await staysTrue(
          'J04.H13',
          async () => expect(await versionOf(sp.id)).toBe(startVersion + 3),
          'the echo changes nothing',
        );
      });
      await waitForContract('J04.H3', async () => {
        const doc = (await searchProducts(token)).items.find(
          (i) => i.id === sp.id,
        );
        return doc?.priceMinor === 777 ? doc : null;
      });
    });
  });

  describe('US8: operators and engineers can see progress', () => {
    let store: Awaited<ReturnType<typeof connectedStore>>;
    let token: string;
    let staff: JourneyClient;

    beforeAll(async () => {
      token = `${run}h`;
      store = await connectedStore('us8', token);
      staff = await JourneyClient.signUp('us8staff');
      await inviteAndAccept(store.shop.owner, store.shop.shopId, staff);
    });

    afterAll(async () => {
      await store?.close();
    });

    it('J04 AS-23: every hop shows its progress through public reads, and the streams and admin reads keep their boundaries', async () => {
      const { shop } = store;

      // The import: counters, bytes, and a stream that a member sees live and a late subscriber sees replayed.
      const file = csv(rowsFor(`${token}i`, 3, { priceCents: 900 }));
      const started = await startImport(
        shop,
        'progress.csv',
        Buffer.byteLength(file),
      );
      const live = await sseClient(shop.owner, topics.import(started.importId));
      const memberLive = await sseClient(
        staff,
        topics.import(started.importId),
      );
      try {
        const parts = await uploadParts(started, Buffer.from(file));
        expect(
          (await completeImport(shop, started.importId, parts)).status,
        ).toBe(202);
        const job = await waitImportTerminal(shop, started.importId);
        expect(job.status).toBe('DONE');
        expect(job.rowsProcessed).toBe(3);
        expect(job.rowsCreated).toBe(3);
        expect(job.rowsFailed).toBe(0);
        expect(job.bytesProcessed).toBe(Buffer.byteLength(file));
        const terminal = (e: {
          event: string;
          data: Record<string, unknown>;
        }) => e.event === 'done' || e.data?.type === 'done';
        await live.next(
          terminal,
          10_000,
          'terminal import event for the owner',
        );
        await memberLive.next(
          terminal,
          10_000,
          'terminal import event for a member',
        );
      } finally {
        live.close();
        memberLive.close();
      }
      const late = await sseClient(shop.owner, topics.import(started.importId));
      try {
        await late.next(
          (e) => e.event === 'done' || e.data?.type === 'done',
          10_000,
          'replayed terminal event for a late subscriber',
        );
      } finally {
        late.close();
      }

      // The integration: status, links, lag, last sync, open conflicts.
      const view = await readIntegration(shop, store.integrationId);
      expect(view.status).toBe('ACTIVE');
      expect(view.linkedProducts).toBe(7);
      expect(view.lastSyncAt).not.toBeNull();
      expect(view.lagSeconds).not.toBeNull();
      expect(view.lastError).toBeNull();
      expect(view.openConflicts).toBe(0);

      // The consumers and the projection lag, as the operator reads them.
      for (const group of [
        'search-product-index',
        'integrations-stock-push',
        'offline-sync-feed',
        'pickup-availability',
      ]) {
        const consumer = await control.consumer(group);
        expect(['RUNNING', 'PAUSED']).toContain(consumer.state);
        expect(consumer.lag).toBeGreaterThanOrEqual(0);
      }
      expect(await indexLag()).toBeGreaterThanOrEqual(0);

      // Boundaries: a non-admin reads none of it; a removed member loses the stream.
      for (const path of [
        '/api/admin/consumers/search-product-index',
        '/api/admin/search/index',
        '/api/admin/jobs',
      ])
        expect((await shop.owner.get(path)).status).toBe(403);
      const removed = await shop.owner.call(
        'DELETE',
        `/api/shops/${shop.shopId}/members/${staff.userId}`,
      );
      expect(removed.status).toBeLessThan(300);
      await expect(
        sseClient(staff, topics.import(started.importId)),
      ).rejects.toThrow(/40[13]/);
    });
  });
});
