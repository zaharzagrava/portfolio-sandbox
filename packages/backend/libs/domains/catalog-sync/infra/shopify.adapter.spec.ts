import { createHmac } from 'node:crypto';
import type { NormaliseResult } from '../domain/normalise';
import {
  ProviderCallError,
  type SyncSession,
} from '../domain/ports/commerce-provider.port';
import { FakeShopify } from '../test/fakes/fake-shopify';
import {
  createHarness,
  FakeAuth,
  type Harness,
} from '../test/fakes/provider-harness';
import { ShopifyAdapter, SHOPIFY_SCOPES } from './shopify.adapter';

const fake = new FakeShopify({
  apiVersion: '2025-10',
  accessToken: 'shpat_valid',
  clientId: 'app-key',
  clientSecret: 'app-secret',
});
const adapter = new ShopifyAdapter({
  appKey: 'app-key',
  appSecret: 'app-secret',
  apiVersion: '2025-10',
});
let h: Harness;
let session: SyncSession;

function stack(token = 'shpat_valid') {
  const target = adapter.apiTarget('fake-store.myshopify.com');
  h = createHarness(fake, {
    provider: 'shopify',
    policy: 'integrations.shopify',
    apiPath: target.apiPath,
    auth: new FakeAuth(
      token,
      (t) => ({ 'x-shopify-access-token': t }),
      'shpat_valid',
    ),
  });
  session = h.session({ locationId: String(fake.locationId) });
}

const all = async (
  fn: (cursor: string | null) => Promise<{ nextCursor: string | null }>,
) => {
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: { nextCursor: string | null } = await fn(cursor);
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  return pages;
};

beforeAll(() => fake.start());
afterAll(() => fake.stop());
beforeEach(() => {
  fake.clearFaults();
  fake.clearLog();
  for (const p of fake.allProducts()) fake.removeProduct(p.id);
  fake.pageSize = 250;
  stack();
});

describe('ShopifyAdapter', () => {
  it('S08 AS-34: the API version comes from configuration and appears in every request path', async () => {
    expect(adapter.apiTarget('acme.myshopify.com')).toEqual({
      origin: 'https://acme.myshopify.com',
      apiPath: '/admin/api/2025-10',
    });
    await adapter.verifyCredentials(session);
    expect(
      fake.requests.every((r) => r.path.startsWith('/admin/api/2025-10/')),
    ).toBe(true);
  });

  describe('S08 AS-01/AS-03: OAuth', () => {
    it('S08 AS-01: the authorize URL carries client id, scopes, redirect and state on the shop host', () => {
      const url = new URL(
        adapter.buildAuthorizeUrl({
          shopDomain: 'acme.myshopify.com',
          state: 's-123',
          redirectUri:
            'https://app.example.com/api/integrations/shopify/callback',
        }),
      );
      expect(url.host).toBe('acme.myshopify.com');
      expect(url.pathname).toBe('/admin/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe('app-key');
      expect(url.searchParams.get('scope')).toBe(SHOPIFY_SCOPES);
      expect(url.searchParams.get('redirect_uri')).toBe(
        'https://app.example.com/api/integrations/shopify/callback',
      );
      expect(url.searchParams.get('state')).toBe('s-123');
    });

    const now = new Date('2026-03-01T12:00:00Z');
    const signed = (params: Record<string, string>, secret = 'app-secret') => {
      const message = Object.keys(params)
        .sort()
        .map((k) => `${k}=${params[k]}`)
        .join('&');
      return {
        ...params,
        hmac: createHmac('sha256', secret).update(message).digest('hex'),
      };
    };
    const base = () => ({
      shop: 'acme.myshopify.com',
      code: 'c1',
      state: 's1',
      timestamp: String(Math.floor(now.getTime() / 1000)),
    });

    it('S08 AS-03: a callback signed with the app secret over its other parameters is accepted', () => {
      expect(adapter.verifyCallback(signed(base()), now)).toEqual({
        shop: 'acme.myshopify.com',
        code: 'c1',
        state: 's1',
      });
    });

    it.each([
      ['wrong secret', () => signed(base(), 'other-secret')],
      ['altered parameter', () => ({ ...signed(base()), code: 'c2' })],
      ['extra parameter', () => ({ ...signed(base()), extra: '1' })],
      ['missing hmac', () => base()],
      [
        'missing state',
        () => {
          const { state: _s, ...rest } = base();
          return signed(rest);
        },
      ],
      [
        'older than 5 minutes',
        () =>
          signed({
            ...base(),
            timestamp: String(Math.floor(now.getTime() / 1000) - 301),
          }),
      ],
      [
        'shop not a myshopify domain',
        () => signed({ ...base(), shop: 'evil.example.com' }),
      ],
      ['truncated hmac', () => ({ ...signed(base()), hmac: 'abcd' })],
    ])('S08 AS-04: %s is rejected', (_name, make) => {
      expect(
        adapter.verifyCallback(make() as Record<string, string>, now),
      ).toBeNull();
    });

    it('S08 AS-04: a timestamp exactly 5 minutes old is still accepted', () => {
      expect(
        adapter.verifyCallback(
          signed({
            ...base(),
            timestamp: String(Math.floor(now.getTime() / 1000) - 300),
          }),
          now,
        ),
      ).not.toBeNull();
    });

    it('S08 AS-03: exchanging the code returns the offline token; one request, never retried', async () => {
      const tokens = await adapter.exchangeCode(session, {
        shopDomain: 'fake-store.myshopify.com',
        code: 'abc',
      });
      expect(tokens.accessToken).toBe('shpat_valid');
      expect(tokens.scope).toContain('write_inventory');
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0].path).toBe('/admin/oauth/access_token');
      expect(
        fake.requests[0].headers['x-shopify-access-token'],
      ).toBeUndefined();
    });

    it('S08 AS-04: a code the provider rejects fails the exchange (no tokens)', async () => {
      fake.validCodes = new Set(['good']);
      try {
        await expect(
          adapter.exchangeCode(session, {
            shopDomain: 'x.myshopify.com',
            code: 'bad',
          }),
        ).rejects.toMatchObject({ kind: 'rejected', status: 400 });
        expect(fake.requests).toHaveLength(1);
      } finally {
        fake.validCodes = undefined;
      }
    });

    it('S08 AS-60: refreshToken asks for the refresh_token grant and maps a refusal to null', async () => {
      await expect(
        adapter.refreshToken(session, { refreshToken: 'r1' }),
      ).resolves.toBeNull();
      expect(fake.requests[0].body).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: 'r1',
      });
    });
  });

  it('S08 AS-03: verifyCredentials reads the shop currency and the primary location', async () => {
    fake.currency = 'EUR';
    try {
      await expect(adapter.verifyCredentials(session)).resolves.toEqual({
        currency: 'EUR',
        locationId: String(fake.locationId),
      });
    } finally {
      fake.currency = 'USD';
    }
  });

  it('S08 AS-03: a bad token surfaces as auth_failed (the connect maps it to provider_credentials_rejected)', async () => {
    // a credential without a refresh token: the 401 is final
    h = createHarness(fake, {
      provider: 'shopify',
      policy: 'integrations.shopify',
      apiPath: adapter.apiTarget('fake-store.myshopify.com').apiPath,
      auth: {
        current: async () => ({
          headers: { 'x-shopify-access-token': 'shpat_wrong' },
          tokenId: 'wrong',
        }),
      },
    });
    session = h.session({ locationId: String(fake.locationId) });
    await expect(adapter.verifyCredentials(session)).rejects.toMatchObject({
      kind: 'auth_failed',
    });
  });

  describe('S08 AS-12: catalog reads', () => {
    it('S08 AS-12: 5 products (2 with two variants) and 1 draft, page size 2 -> 6 listed variants, 1 unlisted, 3 pages', async () => {
      fake.pageSize = 2;
      fake.addProduct({ id: 11, stock: 5, price: '10.00' });
      fake.addProduct({
        id: 12,
        stock: 6,
        extraVariants: [{ stock: 7, price: '12.50' }],
      });
      fake.addProduct({ id: 13, stock: 1, extraVariants: [{ stock: 2 }] });
      fake.addProduct({ id: 14, stock: 9 });
      fake.addProduct({ id: 15, stock: 9, status: 'draft' });
      const results: NormaliseResult[] = [];
      const pages = await all(async (cursor) => {
        const page = await adapter.listChanged(session, {
          since: null,
          pageCursor: cursor,
        });
        for (const item of page.items) results.push(...item.results);
        return page;
      });
      expect(pages).toBe(3);
      const ok = results.filter((r) => r.ok).length;
      expect(ok).toBe(6);
      expect(results.filter((r) => !r.ok)).toEqual([
        expect.objectContaining({ code: 'unlisted' }),
      ]);
    });

    it('S08 AS-12: stock is the level at the integration location, price decimal-parsed, ids are <product>:<variant>', async () => {
      const product = fake.addProduct({ id: 21, stock: 5, price: '19.99' });
      fake.setRemoteStock(product.variants[0].id, 42);
      const page = await adapter.listChanged(session, {
        since: null,
        pageCursor: null,
      });
      const result = page.items[0].results[0];
      expect(result.ok && result.item).toMatchObject({
        externalId: `21:${product.variants[0].id}`,
        stock: 42,
        priceMinor: 1999,
        currency: 'USD',
        externalSku: `shopify:${session.integrationId}:21:${product.variants[0].id}`,
      });
      const reads = fake.requestsTo('GET', /inventory_levels\.json$/);
      expect(reads).toHaveLength(1);
      expect(reads[0].query.location_ids).toBe(String(fake.locationId));
    });

    it('S08 AS-16: updated_at_min is sent on the first page only and narrows the pull', async () => {
      const t0 = new Date('2026-01-01T00:00:00Z');
      fake.addProduct({ id: 31, updatedAt: t0 });
      fake.addProduct({ id: 32, updatedAt: new Date('2026-02-01T00:00:00Z') });
      const page = await adapter.listChanged(session, {
        since: new Date('2026-01-15T00:00:00Z'),
        pageCursor: null,
      });
      expect(page.items.map((i) => i.productId)).toEqual(['32']);
      expect(
        fake.requestsTo('GET', /products\.json$/)[0].query.updated_at_min,
      ).toBe('2026-01-15T00:00:00.000Z');
    });

    it('S08 AS-14: a product with schema drift is reported as a rejected result, the page still succeeds', async () => {
      fake.addProduct({ id: 41 });
      fake.addProduct({ id: 42, stock: 3 });
      fake.malform(41, { variants: 'not-an-array' });
      const page = await adapter.listChanged(session, {
        since: null,
        pageCursor: null,
      });
      expect(page.items).toHaveLength(2);
      expect(page.items[0].results).toEqual([
        expect.objectContaining({ ok: false, code: 'invalid_payload' }),
      ]);
      expect(page.items[1].results[0].ok).toBe(true);
    });

    it('S08 AS-54: an envelope that is not {products: []} fails the page as schema_invalid', async () => {
      fake.inject({
        fault: { kind: 'status', status: 200, json: { products: { id: 1 } } },
      });
      await expect(
        adapter.listChanged(session, { since: null, pageCursor: null }),
      ).rejects.toMatchObject({ kind: 'schema_invalid' });
    });

    it('S08 AS-61: listAllIdsAndDigests returns id, digest and stock of every listed variant', async () => {
      const p = fake.addProduct({
        id: 51,
        stock: 8,
        extraVariants: [{ stock: 4 }],
      });
      fake.addProduct({ id: 52, status: 'draft' });
      const page = await adapter.listAllIdsAndDigests(session, {
        pageCursor: null,
      });
      expect(page.items.map((i) => [i.externalId, i.stock])).toEqual([
        [`51:${p.variants[0].id}`, 8],
        [`51:${p.variants[1].id}`, 4],
      ]);
      expect(page.items[0].digest).toMatch(/^[0-9a-f]{64}$/);
      expect(page.items[0].digest).not.toBe(page.items[1].digest);
    });

    it('S08 AS-22: fetchOne returns the current product, null when it is gone, and ignores a malformed id', async () => {
      const p = fake.addProduct({ id: 61, stock: 2 });
      const one = await adapter.fetchOne(session, `61:${p.variants[0].id}`);
      expect(one?.productId).toBe('61');
      expect(one?.results[0].ok).toBe(true);
      expect(await adapter.fetchOne(session, '61')).not.toBeNull();
      expect(await adapter.fetchOne(session, '9999')).toBeNull();
      fake.clearLog();
      expect(await adapter.fetchOne(session, '../shop')).toBeNull();
      expect(fake.requests).toHaveLength(0);
    });
  });

  describe('S08 AS-36/AS-37: conditional stock write', () => {
    it('S08 AS-36: sends the absolute value with change_from_quantity and the location; accepted', async () => {
      const p = fake.addProduct({ id: 71, stock: 5 });
      const v = p.variants[0];
      await expect(adapter.setStock(session, `71:${v.id}`, 9, 5)).resolves.toBe(
        'accepted',
      );
      expect(fake.stockOf(v.id)).toBe(9);
      expect(fake.stockWrites[0].body).toEqual({
        location_id: fake.locationId,
        inventory_item_id: v.inventory_item_id,
        available: 9,
        change_from_quantity: 5,
      });
    });

    it('S08 AS-37: the seller changed the level first -> 422 is precondition_failed and the level is untouched', async () => {
      const p = fake.addProduct({ id: 72, stock: 5 });
      const v = p.variants[0];
      fake.setRemoteStock(v.id, 6);
      await expect(adapter.setStock(session, `72:${v.id}`, 9, 5)).resolves.toBe(
        'precondition_failed',
      );
      expect(fake.stockOf(v.id)).toBe(6);
    });

    it('S08 AS-37: a concurrent seller edit between our read and our write is caught by the conditional write', async () => {
      const p = fake.addProduct({ id: 73, stock: 5 });
      const v = p.variants[0];
      fake.beforeNextStockWrite(() => fake.setRemoteStock(v.id, 2));
      await expect(adapter.setStock(session, `73:${v.id}`, 9, 5)).resolves.toBe(
        'precondition_failed',
      );
      expect(fake.stockOf(v.id)).toBe(2);
    });

    it('S08 AS-43: a retried write that already landed is accepted (read back equals the value)', async () => {
      const p = fake.addProduct({ id: 74, stock: 9 });
      // first attempt applied but its answer was lost; the retry carries the old expectation and gets 422
      await expect(
        adapter.setStock(session, `74:${p.variants[0].id}`, 9, 5),
      ).resolves.toBe('accepted');
    });

    it('S08 AS-62: a product or variant deleted at the provider is gone', async () => {
      const p = fake.addProduct({ id: 75, stock: 5 });
      await expect(adapter.setStock(session, `75:99999`, 1, 5)).resolves.toBe(
        'gone',
      );
      fake.removeProduct(75);
      await expect(
        adapter.setStock(session, `75:${p.variants[0].id}`, 1, 5),
      ).resolves.toBe('gone');
    });

    it('S08 AS-43: the write is retried on a transient 503 (idempotent), still conditional', async () => {
      const p = fake.addProduct({ id: 76, stock: 5 });
      fake.inject({
        match: (r) => r.method === 'POST',
        fault: { kind: 'status', status: 503 },
        times: 2,
      });
      await expect(
        adapter.setStock(session, `76:${p.variants[0].id}`, 8, 5),
      ).resolves.toBe('accepted');
      expect(fake.stockWrites).toHaveLength(3);
    });

    it('S08 AS-43: 503 on all three attempts surfaces as unavailable', async () => {
      const p = fake.addProduct({ id: 77, stock: 5 });
      fake.inject({
        match: (r) => r.method === 'POST',
        fault: { kind: 'status', status: 503 },
      });
      await expect(
        adapter.setStock(session, `77:${p.variants[0].id}`, 8, 5),
      ).rejects.toMatchObject({ kind: 'unavailable' });
      expect(fake.stockOf(p.variants[0].id)).toBe(5);
    });
  });

  describe('S08 AS-03/AS-69: webhook registration', () => {
    const callbackUrl = 'https://app.example.com/api/integrations/I/webhooks';

    it('S08 AS-03: registers the four topics at the callback URL; the app secret signs (no per-integration secret)', async () => {
      const registered = await adapter.registerWebhooks(session, {
        callbackUrl,
      });
      expect(registered.webhookSecret).toBeNull();
      expect(registered.subscriptions.map((s) => s.topic)).toEqual([
        'products/update',
        'products/delete',
        'inventory_levels/update',
        'app/uninstalled',
      ]);
      expect(
        fake.webhookSubscriptions.map((s) => [s.topic, s.address]),
      ).toEqual(registered.subscriptions.map((s) => [s.topic, callbackUrl]));
    });

    it('S08 AS-09: registering again reuses the existing subscriptions (no duplicates, same ids)', async () => {
      const first = await adapter.registerWebhooks(session, { callbackUrl });
      const second = await adapter.registerWebhooks(session, { callbackUrl });
      expect(second.subscriptions).toEqual(first.subscriptions);
      expect(fake.webhookSubscriptions).toHaveLength(4);
      await adapter.deregisterWebhooks(session, first.subscriptions);
    });

    it('S08 AS-69: deregister removes them; already-removed ones are not an error', async () => {
      const { subscriptions } = await adapter.registerWebhooks(session, {
        callbackUrl: `${callbackUrl}2`,
      });
      await adapter.deregisterWebhooks(session, subscriptions);
      expect(
        fake.webhookSubscriptions.filter((s) =>
          s.address.endsWith('I/webhooks2'),
        ),
      ).toHaveLength(0);
      await expect(
        adapter.deregisterWebhooks(session, subscriptions),
      ).resolves.toBeUndefined();
    });

    it('S08 AS-57: a registration that fails is not retried, and the subscriptions made so far are removed', async () => {
      let posts = 0;
      fake.inject({
        match: (r) =>
          r.method === 'POST' &&
          r.path.endsWith('/webhooks.json') &&
          ++posts === 3,
        fault: { kind: 'status', status: 503 },
        times: 1,
      });
      const before = fake.webhookSubscriptions.length;
      await expect(
        adapter.registerWebhooks(session, { callbackUrl: `${callbackUrl}3` }),
      ).rejects.toBeInstanceOf(ProviderCallError);
      expect(fake.requestsTo('POST', /webhooks\.json$/)).toHaveLength(3);
      expect(fake.webhookSubscriptions).toHaveLength(before);
    });
  });

  describe('S08 AS-26/AS-27: webhook verification and parsing', () => {
    const body = Buffer.from('{"id": 1001}');
    const sign = (raw: Buffer, secret = 'app-secret') =>
      createHmac('sha256', secret).update(raw).digest('base64');

    it('S08 AS-26: verifies the base64 HMAC over the raw bytes with the app secret', () => {
      expect(
        adapter.verifyWebhook({ 'X-Shopify-Hmac-Sha256': sign(body) }, body),
      ).toBe(true);
    });

    it('S08 AS-27: re-serialised bytes, another secret, a missing header and a non-matching length are rejected', () => {
      expect(
        adapter.verifyWebhook(
          { 'x-shopify-hmac-sha256': sign(body) },
          Buffer.from('{"id":1001}'),
        ),
      ).toBe(false);
      expect(
        adapter.verifyWebhook(
          { 'x-shopify-hmac-sha256': sign(body, 'other') },
          body,
        ),
      ).toBe(false);
      expect(adapter.verifyWebhook({}, body)).toBe(false);
      expect(
        adapter.verifyWebhook({ 'x-shopify-hmac-sha256': 'abc' }, body),
      ).toBe(false);
      // a caller-supplied per-integration secret must not replace the app secret
      expect(
        adapter.verifyWebhook(
          { 'x-shopify-hmac-sha256': sign(body, 'integration') },
          body,
          'integration',
        ),
      ).toBe(false);
    });

    const headers = (topic: string, extra: Record<string, string> = {}) => ({
      'x-shopify-topic': topic,
      'x-shopify-webhook-id': 'w1',
      'x-shopify-triggered-at': '2026-03-01T12:00:00Z',
      ...extra,
    });

    it('S08 AS-26: products/update -> product_changed with the product id, delivery id and timestamp', () => {
      expect(adapter.parseWebhook(headers('products/update'), body)).toEqual({
        topic: 'product_changed',
        rawTopic: 'products/update',
        deliveryId: 'w1',
        triggeredAt: '2026-03-01T12:00:00Z',
        externalId: '1001',
      });
    });

    it('S08 AS-30: products/delete, inventory_levels/update, app/uninstalled and unknown topics map to our vocabulary', () => {
      expect(
        adapter.parseWebhook(headers('products/delete'), body)?.topic,
      ).toBe('product_deleted');
      expect(
        adapter.parseWebhook(
          headers('inventory_levels/update'),
          Buffer.from('{"inventory_item_id": 77, "available": 3}'),
        ),
      ).toMatchObject({ topic: 'inventory_changed', inventoryItemId: '77' });
      expect(
        adapter.parseWebhook(
          headers('app/uninstalled'),
          Buffer.from('{"id": 1}'),
        )?.topic,
      ).toBe('app_uninstalled');
      expect(
        adapter.parseWebhook(headers('orders/create'), Buffer.from('{}'))
          ?.topic,
      ).toBe('ignored');
    });

    it('S08 AS-27: malformed input is not understood (null): not JSON, not an object, no id, no delivery id, bad timestamp', () => {
      expect(
        adapter.parseWebhook(headers('products/update'), Buffer.from('{nope')),
      ).toBeNull();
      expect(
        adapter.parseWebhook(headers('products/update'), Buffer.from('[1]')),
      ).toBeNull();
      expect(
        adapter.parseWebhook(
          headers('products/update'),
          Buffer.from('{"id":"../x"}'),
        ),
      ).toBeNull();
      expect(
        adapter.parseWebhook({ 'x-shopify-topic': 'products/update' }, body),
      ).toBeNull();
      expect(
        adapter.parseWebhook(
          headers('products/update', {
            'x-shopify-triggered-at': 'yesterday-ish',
          }),
          body,
        ),
      ).toBeNull();
    });
  });
});
