import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type {
  RawItem,
  SyncSession,
} from '../domain/ports/commerce-provider.port';
import { FakeWooCommerce } from '../test/fakes/fake-woocommerce';
import { createHarness, type Harness } from '../test/fakes/provider-harness';
import { WooCommerceAdapter, wooBasicAuth } from './woocommerce.adapter';

let fake: FakeWooCommerce;
const adapter = new WooCommerceAdapter();
let h: Harness;
let session: SyncSession;

function stack(key = 'ck_test', secret = 'cs_test') {
  h = createHarness(fake, {
    provider: 'woocommerce',
    policy: 'integrations.woocommerce',
    apiPath: adapter.apiTarget('https://shop.example.com').apiPath,
    auth: wooBasicAuth(key, secret),
  });
  session = h.session();
}

// A fresh store per test: products and webhooks never leak between cases.
beforeEach(async () => {
  fake = new FakeWooCommerce({
    consumerKey: 'ck_test',
    consumerSecret: 'cs_test',
  });
  await fake.start();
  stack();
});
afterEach(() => fake.stop());

const sign = (raw: string | Buffer, secret: string) =>
  createHmac('sha256', secret).update(raw).digest('base64');

describe('WooCommerceAdapter', () => {
  it('S08 AS-06: the API root is /wp-json/wc/v3 below the store path', () => {
    expect(adapter.apiTarget('https://shop.example.com')).toEqual({
      origin: 'https://shop.example.com',
      apiPath: '/wp-json/wc/v3',
    });
    expect(adapter.apiTarget('https://example.com/store/')).toEqual({
      origin: 'https://example.com',
      apiPath: '/store/wp-json/wc/v3',
    });
  });

  describe('S08 AS-06: connect checks', () => {
    it('S08 AS-06: one authenticated call proves the keys and reads the store currency', async () => {
      fake.currency = 'EUR';
      try {
        await expect(adapter.verifyCredentials(session)).resolves.toEqual({
          currency: 'EUR',
          locationId: null,
        });
        expect(fake.requests).toHaveLength(1);
        expect(fake.requests[0].path).toBe(
          '/wp-json/wc/v3/settings/general/woocommerce_currency',
        );
        expect(fake.requests[0].headers.authorization).toMatch(/^Basic /);
      } finally {
        fake.currency = 'USD';
      }
    });

    it('S08 AS-06: rejected keys -> auth_failed (mapped to provider_credentials_rejected), not retried', async () => {
      stack('ck_test', 'wrong');
      await expect(adapter.verifyCredentials(session)).rejects.toMatchObject({
        kind: 'auth_failed',
      });
      expect(fake.requests).toHaveLength(1);
    });

    it('S08 AS-06: a provider that answers 5xx -> unavailable (503 provider_unavailable upstream)', async () => {
      fake.inject({ fault: { kind: 'status', status: 503 } });
      await expect(adapter.verifyCredentials(session)).rejects.toMatchObject({
        kind: 'unavailable',
      });
    });
  });

  describe('S08 AS-12: catalog reads', () => {
    it('S08 AS-12: simple products and variations of a variable product become one item each, paged', async () => {
      fake.pageSize = 2;
      fake.addProduct({ id: 201, stock: 5, price: '9.99' });
      fake.addProduct({
        id: 202,
        name: 'Shirt',
        variations: [
          { stock: 3, price: '20.00' },
          { stock: 4, price: '22.00' },
        ],
      });
      fake.addProduct({ id: 203, stock: 1 });
      fake.addProduct({ id: 204, stock: 1, status: 'draft' });
      const items: RawItem[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page: Awaited<ReturnType<typeof adapter.listChanged>> =
          await adapter.listChanged(session, {
            since: null,
            pageCursor: cursor,
          });
        items.push(...page.items);
        cursor = page.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(2);
      const results = items.flatMap((i) => i.results);
      const ok = results.flatMap((r) => (r.ok ? [r.item] : []));
      expect(ok).toHaveLength(4);
      expect(
        ok.map((i) => i.externalId).filter((id) => id.startsWith('202:')),
      ).toHaveLength(2);
      expect(ok.find((i) => i.externalId === '201:201')).toMatchObject({
        priceMinor: 999,
        stock: 5,
        currency: 'USD',
      });
      expect(ok.find((i) => i.title.startsWith('Shirt'))?.title).toMatch(
        /^Shirt — /,
      );
      expect(results.filter((r) => !r.ok)).toEqual([
        expect.objectContaining({ code: 'unlisted' }),
      ]);
    });

    it('S08 AS-16: modified_after narrows the pull (and a write by the seller bumps the item back into it)', async () => {
      fake.addProduct({
        id: 211,
        modifiedAt: new Date('2026-01-01T00:00:00Z'),
      });
      fake.addProduct({
        id: 212,
        modifiedAt: new Date('2026-02-01T00:00:00Z'),
      });
      const page = await adapter.listChanged(session, {
        since: new Date('2026-01-15T00:00:00Z'),
        pageCursor: null,
      });
      expect(page.items.map((i) => i.productId)).toEqual(['212']);
      expect(
        fake.requestsTo('GET', '/wp-json/wc/v3/products')[0].query
          .modified_after,
      ).toBe('2026-01-15T00:00:00.000Z');
      expect(fake.requests[0].query.dates_are_gmt).toBe('true');
    });

    it('S08 AS-14: stock not managed -> rejected inventory_not_tracked; a drifted price -> invalid_price; the page succeeds', async () => {
      fake.addProduct({ id: 221, stock: null });
      fake.addProduct({ id: 222, stock: 2 });
      fake.malform(222, { price: 'abc' });
      const page = await adapter.listChanged(session, {
        since: null,
        pageCursor: null,
      });
      expect(page.items.flatMap((i) => i.results)).toEqual([
        expect.objectContaining({ ok: false, code: 'inventory_not_tracked' }),
        expect.objectContaining({ ok: false, code: 'invalid_price' }),
      ]);
    });

    it('S08 AS-54: an envelope that is not an array fails the page as schema_invalid', async () => {
      fake.inject({
        fault: { kind: 'status', status: 200, json: { products: [] } },
      });
      await expect(
        adapter.listChanged(session, { since: null, pageCursor: null }),
      ).rejects.toMatchObject({ kind: 'schema_invalid' });
    });

    it('S08 AS-54: a Link next to another host is not followed', async () => {
      fake.inject({
        fault: {
          kind: 'status',
          status: 200,
          json: [],
          headers: {
            link: '<https://evil.example.com/wp-json/wc/v3/products?page=2>; rel="next"',
          },
        },
      });
      await expect(
        adapter.listChanged(session, { since: null, pageCursor: null }),
      ).rejects.toMatchObject({ kind: 'schema_invalid' });
    });

    it('S08 AS-54: a page cursor that is not a page number is refused without a call', async () => {
      await expect(
        adapter.listChanged(session, {
          since: null,
          pageCursor: '1&status=any',
        }),
      ).rejects.toMatchObject({ kind: 'schema_invalid' });
      expect(fake.requests).toHaveLength(0);
    });

    it('S08 AS-61: listAllIdsAndDigests returns id, digest and stock', async () => {
      fake.addProduct({ id: 231, stock: 7 });
      const page = await adapter.listAllIdsAndDigests(session, {
        pageCursor: null,
      });
      expect(page.items).toEqual([
        {
          externalId: '231:231',
          digest: expect.stringMatching(/^[0-9a-f]{64}$/),
          stock: 7,
        },
      ]);
    });

    it('S08 AS-22: fetchOne reads a simple product, a single variation, and answers null when gone', async () => {
      fake.addProduct({ id: 241, stock: 2 });
      const variable = fake.addProduct({
        id: 242,
        name: 'Mug',
        variations: [{ stock: 5 }, { stock: 6 }],
      });
      expect(
        (await adapter.fetchOne(session, '241:241'))?.results[0],
      ).toMatchObject({ ok: true });
      expect((await adapter.fetchOne(session, '241'))?.results).toHaveLength(1);
      const variation = await adapter.fetchOne(
        session,
        `242:${variable.variations[1]}`,
      );
      expect(variation?.results).toHaveLength(1);
      expect(variation?.results[0].ok && variation.results[0].item.stock).toBe(
        6,
      );
      expect((await adapter.fetchOne(session, '242'))?.results).toHaveLength(2);
      expect(await adapter.fetchOne(session, '999')).toBeNull();
      expect(await adapter.fetchOne(session, `242:99999`)).toBeNull();
      fake.clearLog();
      expect(await adapter.fetchOne(session, '1/../../x')).toBeNull();
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe('S08 AS-36/AS-37: read-then-write stock', () => {
    it('S08 AS-36: unchanged since the last agreement -> read, re-read, one PUT with the absolute value; accepted', async () => {
      fake.addProduct({ id: 301, stock: 5 });
      await expect(adapter.setStock(session, '301:301', 9, 5)).resolves.toBe(
        'accepted',
      );
      expect(fake.stockOf(301)).toBe(9);
      expect(fake.requests.map((r) => r.method)).toEqual(['GET', 'GET', 'PUT']);
      expect(fake.stockWrites[0].body).toEqual({
        manage_stock: true,
        stock_quantity: 9,
      });
    });

    it('S08 AS-37: the seller changed the stock first -> precondition_failed and nothing is written', async () => {
      fake.addProduct({ id: 302, stock: 5 });
      fake.setRemoteStock(302, 4);
      await expect(adapter.setStock(session, '302:302', 9, 5)).resolves.toBe(
        'precondition_failed',
      );
      expect(fake.stockWrites).toHaveLength(0);
      expect(fake.stockOf(302)).toBe(4);
    });

    it('S08 AS-37: a seller edit between the first read and the re-read is caught before the write', async () => {
      fake.addProduct({ id: 303, stock: 5 });
      let reads = 0;
      const gate = fake.gate(
        (r) =>
          r.method === 'GET' &&
          r.path.endsWith('/products/303') &&
          ++reads === 2,
        { once: true },
      );
      const write = adapter.setStock(session, '303:303', 9, 5);
      await gate.reached;
      fake.setRemoteStock(303, 5); // same quantity, but the item was modified (date_modified_gmt moves on the next second)
      fake.now = () => new Date(Date.now() + 5_000);
      fake.setRemoteStock(303, 5);
      fake.now = () => new Date();
      gate.release();
      await expect(write).resolves.toBe('precondition_failed');
      expect(fake.stockWrites).toHaveLength(0);
    });

    it('S08 AS-37: a quantity change between the two reads is caught', async () => {
      fake.addProduct({ id: 304, stock: 5 });
      let reads = 0;
      const gate = fake.gate(
        (r) =>
          r.method === 'GET' &&
          r.path.endsWith('/products/304') &&
          ++reads === 2,
        { once: true },
      );
      const write = adapter.setStock(session, '304:304', 9, 5);
      await gate.reached;
      fake.setRemoteStock(304, 1);
      gate.release();
      await expect(write).resolves.toBe('precondition_failed');
      expect(fake.stockOf(304)).toBe(1);
    });

    it('S08 AS-36: a variation is written through its own endpoint', async () => {
      const parent = fake.addProduct({
        id: 305,
        variations: [{ stock: 2 }, { stock: 3 }],
      });
      const variationId = parent.variations[0];
      await expect(
        adapter.setStock(session, `305:${variationId}`, 10, 2),
      ).resolves.toBe('accepted');
      expect(fake.stockOf(variationId)).toBe(10);
      expect(fake.stockWrites[0].path).toBe(
        `/wp-json/wc/v3/products/305/variations/${variationId}`,
      );
    });

    it('S08 AS-62: a product or variation deleted at the provider is gone', async () => {
      fake.addProduct({ id: 306, stock: 1 });
      fake.removeProduct(306);
      await expect(adapter.setStock(session, '306:306', 2, 1)).resolves.toBe(
        'gone',
      );
      await expect(adapter.setStock(session, '306:777', 2, 1)).resolves.toBe(
        'gone',
      );
    });

    it('S08 AS-43: the PUT is retried on 503 and the write still lands once', async () => {
      fake.addProduct({ id: 307, stock: 5 });
      fake.inject({
        match: (r) => r.method === 'PUT',
        fault: { kind: 'status', status: 503 },
        times: 2,
      });
      await expect(adapter.setStock(session, '307:307', 8, 5)).resolves.toBe(
        'accepted',
      );
      expect(fake.stockOf(307)).toBe(8);
    });

    it('S08 AS-43: stock not managed any more -> precondition_failed (no PUT)', async () => {
      fake.addProduct({ id: 308, stock: 5 });
      fake.setRemoteStock(308, null);
      await expect(adapter.setStock(session, '308:308', 8, 5)).resolves.toBe(
        'precondition_failed',
      );
      expect(fake.stockWrites).toHaveLength(0);
    });
  });

  describe('S08 AS-06/AS-33: webhooks', () => {
    const callbackUrl = 'https://app.example.com/api/integrations/I/webhooks';

    it('S08 AS-06: registers the product webhooks with a generated per-integration secret (64 hex chars)', async () => {
      const registered = await adapter.registerWebhooks(session, {
        callbackUrl,
      });
      expect(registered.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(registered.subscriptions.map((s) => s.topic)).toEqual([
        'product.created',
        'product.updated',
        'product.deleted',
      ]);
      const mine = fake.webhooks.filter((w) => w.delivery_url === callbackUrl);
      expect(mine).toHaveLength(3);
      expect(
        mine.every(
          (w) => w.secret === registered.webhookSecret && w.status === 'active',
        ),
      ).toBe(true);
      await adapter.deregisterWebhooks(session, registered.subscriptions);
    });

    it('S08 AS-06: two registrations generate different secrets; the repeated connect replaces the old subscriptions', async () => {
      const a = await adapter.registerWebhooks(session, {
        callbackUrl: `${callbackUrl}2`,
      });
      const b = await adapter.registerWebhooks(session, {
        callbackUrl: `${callbackUrl}2`,
      });
      expect(a.webhookSecret).not.toBe(b.webhookSecret);
      const mine = fake.webhooks.filter(
        (w) => w.delivery_url === `${callbackUrl}2`,
      );
      expect(mine).toHaveLength(3);
      expect(mine.every((w) => w.secret === b.webhookSecret)).toBe(true);
    });

    it('S08 AS-69: deregistering removes them and tolerates ones already gone', async () => {
      const { subscriptions } = await adapter.registerWebhooks(session, {
        callbackUrl: `${callbackUrl}3`,
      });
      await adapter.deregisterWebhooks(session, subscriptions);
      expect(
        fake.webhooks.filter((w) => w.delivery_url === `${callbackUrl}3`),
      ).toHaveLength(0);
      await expect(
        adapter.deregisterWebhooks(session, subscriptions),
      ).resolves.toBeUndefined();
    });

    it('S08 AS-69: deregistering by callback URL lists the store subscriptions and removes only those delivering there', async () => {
      await adapter.registerWebhooks(session, {
        callbackUrl: `${callbackUrl}4`,
      });
      await adapter.registerWebhooks(session, {
        callbackUrl: `${callbackUrl}5`,
      });
      await adapter.deregisterWebhooksAt(session, {
        callbackUrl: `${callbackUrl}4`,
      });
      expect(
        fake.webhooks.filter((w) => w.delivery_url === `${callbackUrl}4`),
      ).toHaveLength(0);
      expect(
        fake.webhooks.filter((w) => w.delivery_url === `${callbackUrl}5`),
      ).toHaveLength(3);
      await expect(
        adapter.deregisterWebhooksAt(session, {
          callbackUrl: `${callbackUrl}4`,
        }),
      ).resolves.toBeUndefined();
    });

    it('S08 AS-33: a delivery signed with the integration secret over the raw bytes verifies; others do not', () => {
      const raw = Buffer.from('{"id": 5,  "name":"x"}');
      expect(
        adapter.verifyWebhook(
          { 'X-WC-Webhook-Signature': sign(raw, 'sekret') },
          raw,
          'sekret',
        ),
      ).toBe(true);
      expect(
        adapter.verifyWebhook(
          { 'x-wc-webhook-signature': sign(raw, 'other') },
          raw,
          'sekret',
        ),
      ).toBe(false);
      expect(
        adapter.verifyWebhook(
          { 'x-wc-webhook-signature': sign(raw, 'sekret') },
          Buffer.from('{"id":5,"name":"x"}'),
          'sekret',
        ),
      ).toBe(false);
      expect(adapter.verifyWebhook({}, raw, 'sekret')).toBe(false);
      expect(
        adapter.verifyWebhook(
          { 'x-wc-webhook-signature': sign(raw, 'sekret') },
          raw,
        ),
      ).toBe(false);
      expect(
        adapter.verifyWebhook(
          { 'x-wc-webhook-signature': sign(raw, '') },
          raw,
          '',
        ),
      ).toBe(false);
    });

    const headers = (topic: string) => ({
      'x-wc-webhook-topic': topic,
      'x-wc-webhook-delivery-id': 'd1',
    });

    it('S08 AS-33: product.updated -> product_changed keyed by delivery id; a variation is <parent>:<id>', () => {
      expect(
        adapter.parseWebhook(
          headers('product.updated'),
          Buffer.from('{"id": 10, "parent_id": 0}'),
        ),
      ).toEqual({
        topic: 'product_changed',
        rawTopic: 'product.updated',
        deliveryId: 'd1',
        externalId: '10',
      });
      expect(
        adapter.parseWebhook(
          headers('product.updated'),
          Buffer.from('{"id": 11, "parent_id": 10}'),
        )?.externalId,
      ).toBe('10:11');
      expect(
        adapter.parseWebhook(
          headers('product.deleted'),
          Buffer.from('{"id": 10}'),
        )?.topic,
      ).toBe('product_deleted');
      expect(
        adapter.parseWebhook(
          headers('order.created'),
          Buffer.from('{"id": 10}'),
        )?.topic,
      ).toBe('ignored');
    });

    it('S08 AS-33: the registration ping (form-encoded webhook_id) is a ping, not an error', () => {
      expect(
        adapter.parseWebhook({}, Buffer.from('webhook_id=42')),
      ).toMatchObject({ topic: 'ping' });
    });

    it('S08 AS-27: malformed bodies are not understood', () => {
      expect(
        adapter.parseWebhook(headers('product.updated'), Buffer.from('{nope')),
      ).toBeNull();
      expect(
        adapter.parseWebhook(
          headers('product.updated'),
          Buffer.from('{"name":"x"}'),
        ),
      ).toBeNull();
      expect(
        adapter.parseWebhook(
          { 'x-wc-webhook-topic': 'product.updated' },
          Buffer.from('{"id":1}'),
        ),
      ).toBeNull();
    });

    it('S08 AS-33: the fake provider delivers a webhook our verification accepts (header names match the real ones)', async () => {
      const received: {
        headers: Record<string, string | string[] | undefined>;
        raw: Buffer;
      }[] = [];
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          received.push({ headers: req.headers, raw: Buffer.concat(chunks) });
          res.end('ok');
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      try {
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
        await fake.deliverWebhook(
          url,
          'product.updated',
          { id: 77 },
          { secret: 'topsecret', deliveryId: 'dl-9' },
        );
        expect(
          adapter.verifyWebhook(
            received[0].headers,
            received[0].raw,
            'topsecret',
          ),
        ).toBe(true);
        expect(
          adapter.parseWebhook(received[0].headers, received[0].raw),
        ).toMatchObject({
          topic: 'product_changed',
          deliveryId: 'dl-9',
          externalId: '77',
        });
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });
});
