import {
  composeExternalSku,
  contentDigest,
  normaliseStock,
  stripHtml,
  type NormaliseContext,
} from './normalise';
import { normaliseShopifyProduct } from './normalise-shopify';
import { normaliseWooProduct } from './normalise-woocommerce';

const ctx: NormaliseContext = {
  integrationId: '0190a1b2-0000-7000-8000-000000000001',
  currency: 'USD',
  exponent: 2,
};

const variant = (over: Record<string, unknown> = {}) => ({
  id: 11,
  product_id: 1,
  title: 'Default Title',
  sku: 'S-1',
  price: '19.99',
  inventory_item_id: 501,
  inventory_management: 'shopify',
  inventory_quantity: 7,
  updated_at: '2026-10-01T10:00:00Z',
  ...over,
});
const shopify = (over: Record<string, unknown> = {}) => ({
  id: 1,
  title: 'Cable',
  body_html: '<p>Strong   <b>cable</b></p>',
  vendor: 'Acme',
  product_type: 'Accessories',
  status: 'active',
  tags: 'a, b ,,c',
  updated_at: '2026-10-01T09:00:00Z',
  variants: [variant()],
  ...over,
});

const okItem = (r: ReturnType<typeof normaliseShopifyProduct>[number]) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r.item;
};

describe('S08 normalisation: Shopify', () => {
  it('S08 AS-14: one-variant product keeps the title and maps provider fields', () => {
    const [r] = normaliseShopifyProduct(shopify(), ctx);
    const item = okItem(r);
    expect(item).toMatchObject({
      externalId: '1:11',
      externalSku: `shopify:${ctx.integrationId}:1:11`,
      title: 'Cable',
      description: 'Strong cable',
      brand: 'Acme',
      category: 'Accessories',
      priceMinor: 1999,
      currency: 'USD',
      tags: ['a', 'b', 'c'],
      stock: 7,
    });
    expect(item.updatedAt).toEqual(new Date('2026-10-01T10:00:00Z'));
    expect(item.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('S08 AS-12/AS-14: multi-variant product becomes one item per variant with "<title> — <variant>"', () => {
    const results = normaliseShopifyProduct(
      shopify({
        variants: [
          variant({ id: 11, title: 'Red' }),
          variant({ id: 12, title: 'Default Title', price: '5' }),
          variant({ id: 13, title: 'Blue', inventory_quantity: -4 }),
        ],
      }),
      ctx,
    );
    const items = results.map(okItem);
    expect(items.map((i) => i.externalId)).toEqual(['1:11', '1:12', '1:13']);
    expect(items.map((i) => i.title)).toEqual([
      'Cable — Red',
      'Cable',
      'Cable — Blue',
    ]);
    expect(items[1].priceMinor).toBe(500);
    expect(items[2].stock).toBe(0);
  });

  it('S08 AS-14: single variant with a non-default title still keeps the product title as is', () => {
    const [r] = normaliseShopifyProduct(
      shopify({ variants: [variant({ title: 'Red' })] }),
      ctx,
    );
    expect(okItem(r).title).toBe('Cable');
  });

  it('S08 AS-14: missing product type -> uncategorized, empty vendor allowed, null body -> empty description', () => {
    const [r] = normaliseShopifyProduct(
      shopify({ product_type: '  ', vendor: '', body_html: null, tags: '' }),
      ctx,
    );
    expect(okItem(r)).toMatchObject({
      category: 'uncategorized',
      brand: '',
      description: '',
      tags: [],
    });
  });

  it.each([
    ['title_too_long', { title: 'x'.repeat(201) }],
    ['missing_title', { title: '' }],
    ['missing_title', { title: '   ' }],
    ['missing_title', { title: undefined }],
    ['unlisted', { status: 'draft' }],
    ['unlisted', { status: 'archived' }],
  ])('S08 AS-14: product-level rejection %s for %j', (code, over) => {
    const results = normaliseShopifyProduct(shopify(over), ctx);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, code, externalId: '1:11' });
  });

  it('S08 AS-14: a title of exactly 200 characters is accepted, the composed variant title counts', () => {
    const [ok] = normaliseShopifyProduct(
      shopify({ title: 'x'.repeat(200) }),
      ctx,
    );
    expect(ok.ok).toBe(true);
    const [bad] = normaliseShopifyProduct(
      shopify({
        title: 'x'.repeat(195),
        variants: [
          variant({ title: 'Red' }),
          variant({ id: 12, title: 'Blue' }),
        ],
      }),
      ctx,
    );
    expect(bad).toMatchObject({ ok: false, code: 'title_too_long' });
  });

  it('S08 AS-14: variant without inventory item -> no_inventory_item; other variants unaffected', () => {
    const results = normaliseShopifyProduct(
      shopify({
        variants: [
          variant({ id: 11, inventory_item_id: null }),
          variant({ id: 12, title: 'B' }),
        ],
      }),
      ctx,
    );
    expect(results[0]).toMatchObject({ ok: false, code: 'no_inventory_item' });
    expect(results[1].ok).toBe(true);
  });

  it('S08 AS-14: externalId over 64 characters -> external_id_too_long', () => {
    const [r] = normaliseShopifyProduct(
      shopify({
        id: '1'.repeat(40),
        variants: [variant({ id: '2'.repeat(30) })],
      }),
      ctx,
    );
    expect(r).toMatchObject({ ok: false, code: 'external_id_too_long' });
  });

  it('S08 AS-14: externalId of exactly 64 characters is accepted', () => {
    const [r] = normaliseShopifyProduct(
      shopify({
        id: '1'.repeat(32),
        variants: [variant({ id: '2'.repeat(31) })],
      }),
      ctx,
    );
    expect(okItem(r).externalId).toHaveLength(64);
    expect(okItem(r).externalSku.length).toBeLessThanOrEqual(128);
  });

  it('S08 AS-15: invalid price rejects with invalid_price', () => {
    const [r] = normaliseShopifyProduct(
      shopify({ variants: [variant({ price: '12.999' })] }),
      ctx,
    );
    expect(r).toMatchObject({ ok: false, code: 'invalid_price' });
  });

  it.each([
    ['-3 -> 0', -3, 0],
    ['0', 0, 0],
    ['1e9', 1_000_000_000, 1_000_000_000],
  ])('S08 AS-52: stock %s', (_n, raw, expected) => {
    const [r] = normaliseShopifyProduct(
      shopify({ variants: [variant({ inventory_quantity: raw })] }),
      ctx,
    );
    expect(okItem(r).stock).toBe(expected);
  });

  it.each([
    ['stock_out_of_range', 2_000_000_000],
    ['invalid_stock', 1.5],
    ['invalid_stock', 'abc'],
    ['inventory_level_missing', undefined],
    ['inventory_level_missing', null],
  ])('S08 AS-52: stock quirk %s for %j', (code, raw) => {
    const [r] = normaliseShopifyProduct(
      shopify({ variants: [variant({ inventory_quantity: raw })] }),
      ctx,
    );
    expect(r).toMatchObject({ ok: false, code });
  });

  it('S08 AS-52: untracked inventory -> inventory_not_tracked', () => {
    const [r] = normaliseShopifyProduct(
      shopify({ variants: [variant({ inventory_management: null })] }),
      ctx,
    );
    expect(r).toMatchObject({ ok: false, code: 'inventory_not_tracked' });
  });

  it('S08 AS-14: malformed payloads are rejected as invalid_payload, never thrown', () => {
    expect(() => normaliseShopifyProduct(null, ctx)).not.toThrow();
    expect(normaliseShopifyProduct(null, ctx)).toEqual([
      { ok: false, code: 'invalid_payload', externalId: null },
    ]);
    const r = normaliseShopifyProduct(shopify({ variants: [{}] }), ctx);
    expect(r[0]).toMatchObject({ ok: false, code: 'invalid_payload' });
  });

  it('S08 AS-14: updatedAt is the newer of product and variant; unparseable -> invalid_updated_at', () => {
    const [r] = normaliseShopifyProduct(
      shopify({ updated_at: '2026-10-02T09:00:00Z' }),
      ctx,
    );
    expect(okItem(r).updatedAt).toEqual(new Date('2026-10-02T09:00:00Z'));
    const [bad] = normaliseShopifyProduct(
      shopify({
        updated_at: 'nope',
        variants: [variant({ updated_at: undefined })],
      }),
      ctx,
    );
    expect(bad).toMatchObject({ ok: false, code: 'invalid_updated_at' });
  });

  it('S08 AS-14: output never carries credentials', () => {
    const [r] = normaliseShopifyProduct(
      shopify({
        access_token: 'shpat_secret',
        variants: [variant({ token: 'x' })],
      }),
      ctx,
    );
    expect(JSON.stringify(okItem(r))).not.toMatch(/shpat_|secret|token/);
  });

  it('S08 AS-14: digest changes only with provider-owned fields', () => {
    const base = okItem(normaliseShopifyProduct(shopify(), ctx)[0]);
    const stockOnly = okItem(
      normaliseShopifyProduct(
        shopify({
          variants: [
            variant({
              inventory_quantity: 99,
              updated_at: '2026-11-01T00:00:00Z',
            }),
          ],
        }),
        ctx,
      )[0],
    );
    expect(stockOnly.contentDigest).toBe(base.contentDigest);
    for (const over of [
      { title: 'Cable 2' },
      { body_html: '<p>other</p>' },
      { product_type: 'Other' },
      { vendor: 'Other' },
      { tags: 'a,b' },
      { variants: [variant({ price: '20.00' })] },
    ]) {
      expect(
        okItem(normaliseShopifyProduct(shopify(over), ctx)[0]).contentDigest,
      ).not.toBe(base.contentDigest);
    }
  });
});

const woo = (over: Record<string, unknown> = {}) => ({
  id: 7,
  parent_id: 0,
  name: 'Lamp',
  type: 'simple',
  status: 'publish',
  description: '<p>Bright</p>\n<p>lamp</p>',
  sku: 'L-1',
  price: '29.90',
  manage_stock: true,
  stock_quantity: 4,
  categories: [{ id: 1, name: 'Home', slug: 'home' }],
  tags: [
    { id: 1, name: 'light', slug: 'light' },
    { id: 2, name: 'lamp', slug: 'lamp' },
  ],
  date_modified_gmt: '2026-10-01T10:00:00',
  ...over,
});

describe('S08 normalisation: WooCommerce', () => {
  it('S08 AS-14: simple product maps to <id>:<id>', () => {
    const [r] = normaliseWooProduct(woo(), ctx);
    expect(r.ok && r.item).toMatchObject({
      externalId: '7:7',
      externalSku: `woocommerce:${ctx.integrationId}:7:7`,
      title: 'Lamp',
      description: 'Bright lamp',
      category: 'Home',
      brand: '',
      priceMinor: 2990,
      tags: ['light', 'lamp'],
      stock: 4,
      currency: 'USD',
    });
    expect(r.ok && r.item.updatedAt).toEqual(new Date('2026-10-01T10:00:00Z'));
  });

  it('S08 AS-14: a variation is <parent>:<variation>, titled "<parent> — <attributes>"', () => {
    const [r] = normaliseWooProduct(
      woo({
        id: 70,
        parent_id: 7,
        type: 'variation',
        name: 'ignored',
        attributes: [
          { name: 'Color', option: 'Red' },
          { name: 'Size', option: 'L' },
        ],
      }),
      ctx,
      woo(),
    );
    expect(r.ok && r.item).toMatchObject({
      externalId: '7:70',
      title: 'Lamp — Red / L',
    });
  });

  it('S08 AS-14: no category -> uncategorized; draft/private/pending/trash -> unlisted', () => {
    const [r] = normaliseWooProduct(woo({ categories: [] }), ctx);
    expect(r.ok && r.item.category).toBe('uncategorized');
    for (const status of ['draft', 'private', 'pending', 'trash']) {
      expect(normaliseWooProduct(woo({ status }), ctx)[0]).toMatchObject({
        ok: false,
        code: 'unlisted',
      });
    }
  });

  it.each([
    ['missing_title', { name: '' }],
    ['title_too_long', { name: 'y'.repeat(201) }],
    ['invalid_price', { price: '' }],
    ['inventory_not_tracked', { manage_stock: false, stock_quantity: null }],
    ['inventory_level_missing', { stock_quantity: undefined }],
    ['stock_out_of_range', { stock_quantity: 2_000_000_000 }],
    ['invalid_stock', { stock_quantity: 1.5 }],
    ['external_id_too_long', { id: '9'.repeat(40) }],
  ])('S08 AS-14/AS-52: rejection %s for %j', (code, over) => {
    const [r] = normaliseWooProduct(woo(over), ctx);
    expect(r).toMatchObject({ ok: false, code });
  });

  it('S08 AS-52: negative managed stock is treated as 0 (backorders)', () => {
    const [r] = normaliseWooProduct(woo({ stock_quantity: -2 }), ctx);
    expect(r.ok && r.item.stock).toBe(0);
  });

  it('S08 AS-14: a variable parent itself is not an item', () => {
    expect(normaliseWooProduct(woo({ type: 'variable' }), ctx)).toEqual([]);
  });

  it('S08 AS-14: the digest covers exactly title, description, price, category, brand, tags', () => {
    const fields = {
      title: 'T',
      description: 'D',
      priceMinor: 100,
      category: 'c',
      brand: 'b',
      tags: ['x'],
    };
    expect(contentDigest(fields)).toBe(contentDigest({ ...fields }));
    for (const change of [
      { title: 'U' },
      { description: 'E' },
      { priceMinor: 101 },
      { category: 'd' },
      { brand: 'c' },
      { tags: [] },
    ]) {
      expect(contentDigest({ ...fields, ...change })).not.toBe(
        contentDigest(fields),
      );
    }
  });
});

describe('S08 normalisation helpers', () => {
  it.each([
    ['<p>a</p><p>b</p>', 'a b'],
    ['  a \n\t b  ', 'a b'],
    ['Fish &amp; chips&nbsp;&lt;3', 'Fish & chips <3'],
    ['x<script>alert(1)</script>y', 'x y'],
    ['<br/>', ''],
  ])('S08 AS-14: stripHtml(%j) = %j', (input, out) => {
    expect(stripHtml(input)).toBe(out);
  });

  it('S08 AS-14: externalSku is <provider>:<integrationId>:<externalId> and capped at 128', () => {
    expect(composeExternalSku('shopify', 'I', '1:2')).toBe('shopify:I:1:2');
    expect(
      composeExternalSku('woocommerce', 'I'.repeat(60), 'e'.repeat(64)),
    ).toBeNull();
  });

  it.each([
    [-1, 0],
    [0, 0],
    [5, 5],
    [1_000_000_000, 1_000_000_000],
  ])('S08 AS-52: normaliseStock(%d) = %d', (raw, value) => {
    expect(normaliseStock(raw)).toEqual({ ok: true, value });
  });

  it.each([
    [1_000_000_001, 'stock_out_of_range'],
    [Number.POSITIVE_INFINITY, 'invalid_stock'],
    [Number.NaN, 'invalid_stock'],
    ['5', 'invalid_stock'],
    [undefined, 'inventory_level_missing'],
  ])('S08 AS-52: normaliseStock(%j) -> %s', (raw, code) => {
    expect(normaliseStock(raw)).toEqual({ ok: false, code });
  });
});
