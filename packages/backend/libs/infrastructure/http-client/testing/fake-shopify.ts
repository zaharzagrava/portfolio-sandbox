import { createHmac } from 'node:crypto';
import {
  FakeHttpServer,
  postWebhook,
  type LoggedRequest,
  type Reply,
} from './fake-http-server';

export interface ShopifyVariant {
  id: number;
  product_id: number;
  title: string;
  sku: string | null;
  /** Decimal string in the shop currency, e.g. `"19.99"`. */
  price: string;
  inventory_item_id: number;
  inventory_management: 'shopify' | null;
  /** Mirrors the level at the primary location (read-only on the real API). */
  inventory_quantity: number;
  updated_at: string;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string | null;
  vendor: string;
  product_type: string;
  handle: string;
  status: 'active' | 'draft' | 'archived';
  /** Comma-separated, like the real REST API. */
  tags: string;
  created_at: string;
  updated_at: string;
  variants: ShopifyVariant[];
  images: { id: number; src: string }[];
}

export interface ShopifyWebhookSubscription {
  id: number;
  topic: string;
  address: string;
  format: 'json';
}

export interface FakeShopifyOptions {
  apiVersion?: string;
  /** Page size cap (`limit` is honoured up to this). Default 250 like the real API. */
  pageSize?: number;
  currency?: string;
  /** `myshopify.com` host reported by `shop.json`. */
  shopDomain?: string;
  /** Token `POST /admin/oauth/access_token` hands out and the API accepts. */
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  locationId?: number;
}

export interface NewShopifyProduct {
  id?: number;
  title?: string;
  price?: string;
  sku?: string | null;
  stock?: number;
  /** `false` = no inventory tracking (`inventory_management: null`). */
  tracked?: boolean;
  status?: ShopifyProduct['status'];
  tags?: string;
  bodyHtml?: string | null;
  vendor?: string;
  productType?: string;
  /** Extra variants beyond the first: `{price, stock, sku}`. */
  extraVariants?: { price?: string; stock?: number; sku?: string | null }[];
  updatedAt?: Date;
}

/**
 * Fake Shopify Admin REST API (real paths and response shapes): OAuth token exchange, `shop.json`, `locations.json`,
 * paginated `products.json` (cursor in `Link: rel="next"`, `updated_at_min`), `inventory_levels` read and conditional
 * `set` (`change_from_quantity`: a mismatch answers `422`), webhook subscriptions. A write bumps `updated_at`.
 * Control methods change the "seller side" the way the Shopify admin UI would.
 */
export class FakeShopify extends FakeHttpServer {
  readonly apiVersion: string;
  /** The one token the API accepts; `expireAccessToken` / a refresh replace it. */
  accessToken: string;
  /** The refresh token the token endpoint accepts for `grant_type=refresh_token`; `null` = none is valid. */
  validRefreshToken: string | null = null;
  private tokenSeq = 0;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly locationId: number;
  readonly shopDomain: string;
  currency: string;
  /** Maximum items per page; change between calls to test paging. */
  pageSize: number;

  private nextId = 1_000;
  private readonly products = new Map<number, ShopifyProduct>();
  /** `inventory_item_id` -> available at the primary location. */
  private readonly levels = new Map<number, number>();
  private readonly subscriptions = new Map<
    number,
    ShopifyWebhookSubscription
  >();
  private beforeWrite?: () => void;
  /** Codes accepted by `/admin/oauth/access_token`; any non-empty code when `undefined`. */
  validCodes?: Set<string>;

  constructor(options: FakeShopifyOptions = {}) {
    super();
    this.apiVersion = options.apiVersion ?? '2025-07';
    this.pageSize = options.pageSize ?? 250;
    this.currency = options.currency ?? 'USD';
    this.shopDomain = options.shopDomain ?? 'fake-store.myshopify.com';
    this.accessToken = options.accessToken ?? 'shpat_fake_token';
    this.clientId = options.clientId ?? 'fake-client-id';
    this.clientSecret = options.clientSecret ?? 'fake-client-secret';
    this.locationId = options.locationId ?? 9_001;
  }

  private get apiPrefix(): string {
    return `/admin/api/${this.apiVersion}`;
  }

  // ---- seller-side control -------------------------------------------------------------------------------------

  /** The access token the platform holds stops working (expired / revoked); `refreshToken` stays valid when given. */
  expireAccessToken(refreshToken: string | null = null): void {
    this.tokenSeq++;
    this.accessToken = `shpat_server_side_${this.tokenSeq}`;
    this.validRefreshToken = refreshToken;
  }

  /** Token-endpoint calls that were refresh grants. */
  get refreshGrants(): LoggedRequest[] {
    return this.requestsTo('POST', /\/admin\/oauth\/access_token$/).filter(
      (r) =>
        (r.body as { grant_type?: string } | undefined)?.grant_type ===
        'refresh_token',
    );
  }

  /** Adds a product (one variant plus `extraVariants`); `updated_at` is now unless given. */
  addProduct(input: NewShopifyProduct = {}): ShopifyProduct {
    const id = input.id ?? this.nextId++;
    const stamp = (input.updatedAt ?? this.now()).toISOString();
    const make = (
      i: number,
      v: { price?: string; stock?: number; sku?: string | null },
    ): ShopifyVariant => {
      const itemId = this.nextId++;
      const tracked = input.tracked ?? true;
      if (tracked) this.levels.set(itemId, v.stock ?? 0);
      return {
        id: this.nextId++,
        product_id: id,
        title: i === 0 ? 'Default Title' : `Variant ${i}`,
        sku: v.sku === undefined ? `SKU-${id}-${i}` : v.sku,
        price: v.price ?? '10.00',
        inventory_item_id: itemId,
        inventory_management: tracked ? 'shopify' : null,
        inventory_quantity: tracked ? (v.stock ?? 0) : 0,
        updated_at: stamp,
      };
    };
    const product: ShopifyProduct = {
      id,
      title: input.title ?? `Product ${id}`,
      body_html: input.bodyHtml === undefined ? '<p>Nice</p>' : input.bodyHtml,
      vendor: input.vendor ?? 'Acme',
      product_type: input.productType ?? 'Gadgets',
      handle: `product-${id}`,
      status: input.status ?? 'active',
      tags: input.tags ?? '',
      created_at: stamp,
      updated_at: stamp,
      variants: [
        make(0, { price: input.price, stock: input.stock, sku: input.sku }),
        ...(input.extraVariants ?? []).map((v, i) => make(i + 1, v)),
      ],
      images: [],
    };
    this.products.set(id, product);
    return product;
  }

  /** Edits fields of a product as the seller would; bumps `updated_at`. */
  updateProduct(
    id: number,
    patch: Partial<
      Pick<
        ShopifyProduct,
        'title' | 'body_html' | 'tags' | 'status' | 'vendor' | 'product_type'
      >
    > & { price?: string },
  ): ShopifyProduct {
    const product = this.require(id);
    const { price, ...fields } = patch;
    Object.assign(product, fields);
    if (price !== undefined) product.variants[0].price = price;
    this.touch(product);
    return product;
  }

  /** Seller changes the on-hand quantity of a variant; bumps `updated_at`. */
  setRemoteStock(variantId: number, available: number): void {
    const { product, variant } = this.findVariant(variantId);
    this.levels.set(variant.inventory_item_id, available);
    variant.inventory_quantity = available;
    this.touch(product);
  }

  stockOf(variantId: number): number {
    return this.levels.get(
      this.findVariant(variantId).variant.inventory_item_id,
    )!;
  }

  removeProduct(id: number): void {
    this.products.delete(id);
  }

  /** Puts a product removed earlier back with the same ids (the seller relists it). */
  restoreProduct(product: ShopifyProduct): void {
    this.products.set(product.id, product);
  }

  getProduct(id: number): ShopifyProduct | undefined {
    return this.products.get(id);
  }

  allProducts(): ShopifyProduct[] {
    return [...this.products.values()];
  }

  /**
   * Replaces what the API serves for a product with an arbitrary JSON object (schema drift: price `"free"`, missing
   * title, variants not an array...). The merge is shallow over the stored product.
   */
  malform(id: number, override: Record<string, unknown>): void {
    Object.assign(this.require(id), override);
  }

  /** Runs once, right before the next `inventory_levels/set` is evaluated (a concurrent seller edit). */
  beforeNextStockWrite(fn: () => void): void {
    this.beforeWrite = fn;
  }

  /** Stock writes received (successful or not), oldest first. */
  get stockWrites(): LoggedRequest[] {
    return this.requestsTo('POST', /\/inventory_levels\/set\.json$/);
  }

  get webhookSubscriptions(): ShopifyWebhookSubscription[] {
    return [...this.subscriptions.values()];
  }

  /** Signs and posts a webhook to the app the way Shopify does (`X-Shopify-Hmac-Sha256` over the raw body). */
  async deliverWebhook(
    url: string,
    topic: string,
    payload: unknown,
    options: {
      secret?: string;
      webhookId?: string;
      triggeredAt?: Date;
      rawBody?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const rawBody = options.rawBody ?? JSON.stringify(payload);
    const signature = createHmac('sha256', options.secret ?? this.clientSecret)
      .update(rawBody)
      .digest('base64');
    return postWebhook(
      url,
      {
        'x-shopify-topic': topic,
        'x-shopify-hmac-sha256': signature,
        'x-shopify-shop-domain': this.shopDomain,
        'x-shopify-api-version': this.apiVersion,
        'x-shopify-webhook-id':
          options.webhookId ?? `wh-${this.nextId++}-${this.clockMs()}`,
        'x-shopify-triggered-at': (
          options.triggeredAt ?? this.now()
        ).toISOString(),
        ...options.headers,
      },
      rawBody,
    );
  }

  // ---- HTTP ----------------------------------------------------------------------------------------------------

  protected override unauthorizedReply(): Reply {
    return {
      status: 401,
      json: {
        errors:
          '[API] Invalid API key or access token (unrecognized login or wrong password)',
      },
    };
  }

  protected route(request: LoggedRequest): Reply {
    const { method, path } = request;

    if (path === '/admin/oauth/access_token' && method === 'POST') {
      const body = (request.body ?? {}) as Record<string, string>;
      if (body.grant_type === 'refresh_token') {
        if (
          body.client_id !== this.clientId ||
          body.client_secret !== this.clientSecret ||
          this.validRefreshToken === null ||
          body.refresh_token !== this.validRefreshToken
        )
          return { status: 400, json: { error: 'invalid_grant' } };
        this.tokenSeq++;
        this.accessToken = `shpat_refreshed_${this.tokenSeq}`;
        this.validRefreshToken = `shprt_${this.tokenSeq}`;
        return {
          status: 200,
          json: {
            access_token: this.accessToken,
            refresh_token: this.validRefreshToken,
            expires_in: 3600,
            scope: 'read_products,write_inventory,read_inventory',
          },
        };
      }
      if (
        body.client_id !== this.clientId ||
        body.client_secret !== this.clientSecret ||
        !body.code ||
        (this.validCodes && !this.validCodes.has(body.code))
      )
        return { status: 400, json: { error: 'invalid_request' } };
      return {
        status: 200,
        json: {
          access_token: this.accessToken,
          scope: 'read_products,write_inventory,read_inventory',
        },
      };
    }

    if (!path.startsWith(`${this.apiPrefix}/`))
      return { status: 404, json: { errors: 'Not Found' } };
    if (request.headers['x-shopify-access-token'] !== this.accessToken)
      return this.unauthorizedReply();
    const rest = path.slice(this.apiPrefix.length);

    if (rest === '/shop.json' && method === 'GET')
      return {
        status: 200,
        json: {
          shop: {
            id: 1,
            name: 'Fake Store',
            domain: this.shopDomain,
            myshopify_domain: this.shopDomain,
            currency: this.currency,
            primary_location_id: this.locationId,
          },
        },
      };

    if (rest === '/locations.json' && method === 'GET')
      return {
        status: 200,
        json: {
          locations: [
            {
              id: this.locationId,
              name: 'Main warehouse',
              active: true,
              legacy: false,
            },
          ],
        },
      };

    if (rest === '/products.json' && method === 'GET')
      return this.listProducts(request);

    const one = /^\/products\/(\d+)\.json$/.exec(rest);
    if (one && method === 'GET') {
      const product = this.products.get(Number(one[1]));
      return product
        ? { status: 200, json: { product } }
        : { status: 404, json: { errors: 'Not Found' } };
    }

    if (rest === '/inventory_levels.json' && method === 'GET') {
      const ids = (request.query.inventory_item_ids ?? '')
        .split(',')
        .filter(Boolean)
        .map(Number);
      return {
        status: 200,
        json: {
          inventory_levels: ids
            .filter((id) => this.levels.has(id))
            .map((id) => this.levelJson(id)),
        },
      };
    }

    if (rest === '/inventory_levels/set.json' && method === 'POST')
      return this.setLevel(request);

    if (rest === '/webhooks.json' && method === 'GET')
      return {
        status: 200,
        json: { webhooks: [...this.subscriptions.values()] },
      };
    if (rest === '/webhooks.json' && method === 'POST') {
      const w = ((request.body ?? {}) as { webhook?: Record<string, string> })
        .webhook;
      if (!w?.topic || !w.address)
        return { status: 422, json: { errors: { topic: ['required'] } } };
      const duplicate = [...this.subscriptions.values()].find(
        (s) => s.topic === w.topic && s.address === w.address,
      );
      if (duplicate)
        return {
          status: 422,
          json: {
            errors: { address: ['for this topic has already been taken'] },
          },
        };
      const sub: ShopifyWebhookSubscription = {
        id: this.nextId++,
        topic: w.topic,
        address: w.address,
        format: 'json',
      };
      this.subscriptions.set(sub.id, sub);
      return { status: 201, json: { webhook: sub } };
    }
    const hook = /^\/webhooks\/(\d+)\.json$/.exec(rest);
    if (hook && method === 'DELETE') {
      const had = this.subscriptions.delete(Number(hook[1]));
      return had
        ? { status: 200, json: {} }
        : { status: 404, json: { errors: 'Not Found' } };
    }

    return { status: 404, json: { errors: 'Not Found' } };
  }

  private listProducts(request: LoggedRequest): Reply {
    // Cursor pagination: `page_info` carries the filter and the position (the real API forbids other filters then).
    let afterId = 0;
    let updatedMin: string | undefined = request.query.updated_at_min;
    if (request.query.page_info) {
      try {
        const token = JSON.parse(
          Buffer.from(request.query.page_info, 'base64url').toString('utf8'),
        ) as { afterId: number; updatedMin?: string };
        afterId = token.afterId;
        updatedMin = token.updatedMin;
      } catch {
        return { status: 400, json: { errors: 'Invalid page_info' } };
      }
    }
    const limit = Math.min(
      Number(request.query.limit ?? this.pageSize) || this.pageSize,
      this.pageSize,
    );
    const min = updatedMin ? Date.parse(updatedMin) : -Infinity;
    const matching = [...this.products.values()]
      .filter((p) => p.id > afterId && Date.parse(p.updated_at) >= min)
      .filter((p) => !request.query.status || p.status === request.query.status)
      .sort((a, b) => a.id - b.id);
    const page = matching.slice(0, limit);
    const headers: Record<string, string> = {};
    if (matching.length > limit) {
      const token = Buffer.from(
        JSON.stringify({ afterId: page[page.length - 1].id, updatedMin }),
      ).toString('base64url');
      headers.link = `<${this.baseUrl}${this.apiPrefix}/products.json?limit=${limit}&page_info=${token}>; rel="next"`;
    }
    return { status: 200, headers, json: { products: page } };
  }

  private setLevel(request: LoggedRequest): Reply {
    const body = (request.body ?? {}) as {
      location_id?: number;
      inventory_item_id?: number;
      available?: number;
      change_from_quantity?: number | null;
    };
    const pending = this.beforeWrite;
    this.beforeWrite = undefined;
    pending?.();

    const item = body.inventory_item_id;
    if (
      item === undefined ||
      !Number.isInteger(body.available) ||
      body.location_id !== this.locationId
    )
      return { status: 422, json: { errors: { available: ['is invalid'] } } };
    if (!this.levels.has(item))
      return { status: 404, json: { errors: 'Not Found' } };
    const current = this.levels.get(item)!;
    if (
      body.change_from_quantity !== undefined &&
      body.change_from_quantity !== null &&
      body.change_from_quantity !== current
    )
      return {
        status: 422,
        json: {
          errors: [
            'The quantity has changed since it was read: change_from_quantity does not match the available quantity',
          ],
        },
      };
    this.levels.set(item, body.available!);
    for (const product of this.products.values())
      for (const variant of product.variants)
        if (variant.inventory_item_id === item) {
          variant.inventory_quantity = body.available!;
          this.touch(product);
        }
    return { status: 200, json: { inventory_level: this.levelJson(item) } };
  }

  private levelJson(itemId: number) {
    return {
      inventory_item_id: itemId,
      location_id: this.locationId,
      available: this.levels.get(itemId),
      updated_at: this.now().toISOString(),
    };
  }

  private touch(product: ShopifyProduct): void {
    const stamp = this.now().toISOString();
    product.updated_at = stamp;
    for (const v of product.variants) v.updated_at = stamp;
  }

  private require(id: number): ShopifyProduct {
    const product = this.products.get(id);
    if (!product) throw new Error(`fake shopify: no product ${id}`);
    return product;
  }

  private findVariant(variantId: number) {
    for (const product of this.products.values())
      for (const variant of product.variants)
        if (variant.id === variantId) return { product, variant };
    throw new Error(`fake shopify: no variant ${variantId}`);
  }
}
