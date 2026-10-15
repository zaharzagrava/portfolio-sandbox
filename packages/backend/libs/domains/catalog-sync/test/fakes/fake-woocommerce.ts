import { createHmac } from 'node:crypto';
import {
  FakeHttpServer,
  postWebhook,
  type LoggedRequest,
  type Reply,
} from './fake-http-server';

export interface WooProduct {
  id: number;
  parent_id: number;
  name: string;
  slug: string;
  type: 'simple' | 'variable' | 'variation';
  status: 'publish' | 'draft' | 'private' | 'pending' | 'trash';
  description: string;
  short_description: string;
  sku: string;
  /** Decimal string, e.g. `"19.99"`; empty when unpriced. */
  price: string;
  regular_price: string;
  sale_price: string;
  manage_stock: boolean;
  /** `null` when stock is not managed. */
  stock_quantity: number | null;
  stock_status: 'instock' | 'outofstock' | 'onbackorder';
  categories: { id: number; name: string; slug: string }[];
  tags: { id: number; name: string; slug: string }[];
  images: { id: number; src: string }[];
  /** Variation ids (variable products only). */
  variations: number[];
  date_created_gmt: string;
  date_modified_gmt: string;
}

export interface WooWebhook {
  id: number;
  name: string;
  status: 'active' | 'paused' | 'disabled';
  topic: string;
  delivery_url: string;
  secret: string;
}

export interface FakeWooCommerceOptions {
  consumerKey?: string;
  consumerSecret?: string;
  /** Items per page cap (`per_page` honoured up to this). Default 100 like the real API. */
  pageSize?: number;
  currency?: string;
}

export interface NewWooProduct {
  id?: number;
  name?: string;
  price?: string;
  sku?: string;
  /** `null` = stock not managed. */
  stock?: number | null;
  status?: WooProduct['status'];
  description?: string;
  categories?: string[];
  tags?: string[];
  /** Makes a variable product with these variations (`{price, stock, sku}`). */
  variations?: { price?: string; stock?: number | null; sku?: string }[];
  modifiedAt?: Date;
}

const gmt = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, '');

/**
 * Fake WooCommerce REST API v3 (`/wp-json/wc/v3`): Basic auth (or `consumer_key`/`consumer_secret` query), paginated
 * `products` with `X-WP-Total`, `X-WP-TotalPages` and `Link rel="next"`, `modified_after`, variations, general
 * settings (currency), webhooks. WooCommerce has no compare-and-set: a stock `PUT` just overwrites, so the adapter's
 * read-then-write is raced with `beforeNextStockWrite`. A write bumps `date_modified_gmt`.
 */
export class FakeWooCommerce extends FakeHttpServer {
  readonly consumerKey: string;
  readonly consumerSecret: string;
  currency: string;
  /** Maximum items per page; change between calls to test paging. */
  pageSize: number;

  private nextId = 100;
  private readonly products = new Map<number, WooProduct>();
  private readonly hooks = new Map<number, WooWebhook>();
  private beforeWrite?: () => void;

  constructor(options: FakeWooCommerceOptions = {}) {
    super();
    this.consumerKey = options.consumerKey ?? 'ck_fake';
    this.consumerSecret = options.consumerSecret ?? 'cs_fake';
    this.pageSize = options.pageSize ?? 100;
    this.currency = options.currency ?? 'USD';
  }

  // ---- seller-side control -------------------------------------------------------------------------------------

  addProduct(input: NewWooProduct = {}): WooProduct {
    const id = input.id ?? this.nextId++;
    const stamp = gmt(input.modifiedAt ?? this.now());
    const variations = (input.variations ?? []).map((v) =>
      this.build({
        id: this.nextId++,
        parent_id: id,
        type: 'variation',
        name: `Variation of ${id}`,
        price: v.price ?? '10.00',
        stock: v.stock === undefined ? 0 : v.stock,
        sku: v.sku ?? `SKU-${id}-v${this.nextId}`,
        status: 'publish',
        stamp,
      }),
    );
    for (const v of variations) this.products.set(v.id, v);
    const product = this.build({
      id,
      parent_id: 0,
      type: variations.length ? 'variable' : 'simple',
      name: input.name ?? `Product ${id}`,
      price: input.price ?? '10.00',
      stock: input.stock === undefined ? 0 : input.stock,
      sku: input.sku ?? `SKU-${id}`,
      status: input.status ?? 'publish',
      stamp,
      description: input.description,
      categories: input.categories,
      tags: input.tags,
      variations: variations.map((v) => v.id),
    });
    this.products.set(id, product);
    return product;
  }

  /** Edits fields as the seller would; bumps `date_modified_gmt`. */
  updateProduct(
    id: number,
    patch: Partial<
      Pick<WooProduct, 'name' | 'description' | 'status' | 'sku'>
    > & { price?: string },
  ): WooProduct {
    const product = this.require(id);
    const { price, ...fields } = patch;
    Object.assign(product, fields);
    if (price !== undefined) {
      product.price = price;
      product.regular_price = price;
    }
    this.touch(product);
    return product;
  }

  /** Seller changes the stock of a product or variation; bumps `date_modified_gmt`. */
  setRemoteStock(id: number, quantity: number | null): void {
    const product = this.require(id);
    this.applyStock(product, quantity);
    this.touch(product);
  }

  stockOf(id: number): number | null {
    return this.require(id).stock_quantity;
  }

  removeProduct(id: number): void {
    const product = this.products.get(id);
    this.products.delete(id);
    for (const v of product?.variations ?? []) this.products.delete(v);
  }

  getProduct(id: number): WooProduct | undefined {
    return this.products.get(id);
  }

  /** Shallow override of what the API serves for an item (schema drift: price `"abc"`, `name` missing...). */
  malform(id: number, override: Record<string, unknown>): void {
    Object.assign(this.require(id), override);
  }

  /** Runs once, right before the next stock `PUT` is applied (a concurrent seller edit between read and write). */
  beforeNextStockWrite(fn: () => void): void {
    this.beforeWrite = fn;
  }

  /** `PUT` requests that carried a stock quantity, oldest first. */
  get stockWrites(): LoggedRequest[] {
    return this.requestsTo('PUT', /\/products\//).filter(
      (r) =>
        r.body !== null &&
        typeof r.body === 'object' &&
        'stock_quantity' in (r.body as object),
    );
  }

  get webhooks(): WooWebhook[] {
    return [...this.hooks.values()];
  }

  /** Signs and posts a webhook the way WooCommerce does (`X-WC-Webhook-Signature`, base64 HMAC-SHA256 of the body). */
  async deliverWebhook(
    url: string,
    topic: string,
    payload: unknown,
    options: {
      /** Default: the secret the app registered for this topic, else empty. */
      secret?: string;
      deliveryId?: string;
      rawBody?: string;
      headers?: Record<string, string>;
    } = {},
  ) {
    const rawBody = options.rawBody ?? JSON.stringify(payload);
    const secret =
      options.secret ??
      [...this.hooks.values()].find(
        (h) => h.topic === topic && h.delivery_url === url,
      )?.secret ??
      '';
    const [resource, event] = topic.split('.');
    const hook = [...this.hooks.values()].find((h) => h.topic === topic);
    return postWebhook(
      url,
      {
        'x-wc-webhook-signature': createHmac('sha256', secret)
          .update(rawBody)
          .digest('base64'),
        'x-wc-webhook-topic': topic,
        'x-wc-webhook-resource': resource,
        'x-wc-webhook-event': event,
        'x-wc-webhook-id': String(hook?.id ?? 0),
        'x-wc-webhook-delivery-id':
          options.deliveryId ?? `dl-${this.nextId++}-${Date.now()}`,
        'x-wc-webhook-source': this.baseUrl,
        'user-agent': 'WooCommerce/9.0 Hookshot (WordPress/6.6)',
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
        code: 'woocommerce_rest_cannot_view',
        message: 'Sorry, you cannot list resources.',
        data: { status: 401 },
      },
    };
  }

  protected route(request: LoggedRequest): Reply {
    const prefix = '/wp-json/wc/v3';
    if (!request.path.startsWith(`${prefix}/`) && request.path !== prefix)
      return {
        status: 404,
        json: {
          code: 'rest_no_route',
          message: 'No route was found matching the URL and request method.',
          data: { status: 404 },
        },
      };
    if (!this.authorised(request)) return this.unauthorizedReply();
    const rest = request.path.slice(prefix.length);
    const { method } = request;

    if (rest === '/products' && method === 'GET')
      return this.listProducts(request, (p) => p.type !== 'variation');

    const variationsOf = /^\/products\/(\d+)\/variations$/.exec(rest);
    if (variationsOf && method === 'GET')
      return this.listProducts(
        request,
        (p) => p.parent_id === Number(variationsOf[1]),
      );

    const variation = /^\/products\/(\d+)\/variations\/(\d+)$/.exec(rest);
    if (variation) {
      const item = this.products.get(Number(variation[2]));
      if (!item || item.parent_id !== Number(variation[1]))
        return this.notFound('woocommerce_rest_product_variation_invalid_id');
      return method === 'GET'
        ? { status: 200, json: item }
        : this.putItem(item, request);
    }

    const one = /^\/products\/(\d+)$/.exec(rest);
    if (one) {
      const item = this.products.get(Number(one[1]));
      if (!item) return this.notFound('woocommerce_rest_product_invalid_id');
      if (method === 'GET') return { status: 200, json: item };
      if (method === 'PUT' || method === 'POST')
        return this.putItem(item, request);
    }

    if (rest === '/settings/general/woocommerce_currency' && method === 'GET')
      return {
        status: 200,
        json: { id: 'woocommerce_currency', value: this.currency },
      };
    if (rest === '/data/currencies/current' && method === 'GET')
      return {
        status: 200,
        json: { code: this.currency, name: this.currency, symbol: '$' },
      };
    if (rest === '/system_status' && method === 'GET')
      return {
        status: 200,
        json: {
          environment: { version: '9.0.0' },
          settings: { currency: this.currency },
        },
      };

    if (rest === '/webhooks' && method === 'GET')
      return { status: 200, json: [...this.hooks.values()] };
    if (rest === '/webhooks' && method === 'POST') {
      const b = (request.body ?? {}) as Partial<WooWebhook>;
      if (!b.topic || !b.delivery_url)
        return {
          status: 400,
          json: {
            code: 'rest_missing_callback_param',
            message: 'Missing parameter(s): topic, delivery_url',
            data: { status: 400 },
          },
        };
      const hook: WooWebhook = {
        id: this.nextId++,
        name: b.name ?? `Webhook ${b.topic}`,
        status: b.status ?? 'active',
        topic: b.topic,
        delivery_url: b.delivery_url,
        secret: b.secret ?? '',
      };
      this.hooks.set(hook.id, hook);
      return { status: 201, json: hook };
    }
    const hookOne = /^\/webhooks\/(\d+)$/.exec(rest);
    if (hookOne && method === 'DELETE') {
      const hook = this.hooks.get(Number(hookOne[1]));
      if (!hook) return this.notFound('woocommerce_rest_webhook_invalid_id');
      this.hooks.delete(hook.id);
      return { status: 200, json: hook };
    }

    return this.notFound('rest_no_route');
  }

  private authorised(request: LoggedRequest): boolean {
    const header = request.headers.authorization;
    if (header?.startsWith('Basic ')) {
      const [key, secret] = Buffer.from(header.slice(6), 'base64')
        .toString('utf8')
        .split(':');
      return key === this.consumerKey && secret === this.consumerSecret;
    }
    return (
      request.query.consumer_key === this.consumerKey &&
      request.query.consumer_secret === this.consumerSecret
    );
  }

  private notFound(code: string): Reply {
    return {
      status: 404,
      json: { code, message: 'Invalid ID.', data: { status: 404 } },
    };
  }

  private listProducts(
    request: LoggedRequest,
    filter: (p: WooProduct) => boolean,
  ): Reply {
    const perPage = Math.min(
      Number(request.query.per_page ?? 10) || 10,
      this.pageSize,
    );
    const page = Math.max(Number(request.query.page ?? 1) || 1, 1);
    const after = request.query.modified_after
      ? Date.parse(
          request.query.modified_after.endsWith('Z')
            ? request.query.modified_after
            : `${request.query.modified_after}Z`,
        )
      : -Infinity;
    const matching = [...this.products.values()]
      .filter(filter)
      .filter((p) => Date.parse(`${p.date_modified_gmt}Z`) > after)
      .filter((p) => !request.query.status || p.status === request.query.status)
      .sort((a, b) => a.id - b.id);
    const totalPages = Math.max(Math.ceil(matching.length / perPage), 1);
    const headers: Record<string, string> = {
      'x-wp-total': String(matching.length),
      'x-wp-totalpages': String(totalPages),
    };
    if (page < totalPages) {
      const params = new URLSearchParams(request.query);
      params.set('page', String(page + 1));
      params.set('per_page', String(perPage));
      headers.link = `<${this.baseUrl}${request.path}?${params.toString()}>; rel="next"`;
    }
    return {
      status: 200,
      headers,
      json: matching.slice((page - 1) * perPage, page * perPage),
    };
  }

  private putItem(item: WooProduct, request: LoggedRequest): Reply {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if ('stock_quantity' in body) {
      const pending = this.beforeWrite;
      this.beforeWrite = undefined;
      pending?.();
      const q = body.stock_quantity;
      if (q !== null && !Number.isInteger(q))
        return {
          status: 400,
          json: {
            code: 'rest_invalid_param',
            message: 'Invalid parameter(s): stock_quantity',
            data: { status: 400 },
          },
        };
      this.applyStock(item, q as number | null);
    }
    for (const field of ['name', 'description', 'status', 'sku'] as const)
      if (typeof body[field] === 'string')
        (item as unknown as Record<string, unknown>)[field] = body[field];
    this.touch(item);
    return { status: 200, json: item };
  }

  private applyStock(item: WooProduct, quantity: number | null): void {
    item.manage_stock = quantity !== null;
    item.stock_quantity = quantity;
    item.stock_status =
      quantity === null || quantity > 0 ? 'instock' : 'outofstock';
  }

  private touch(item: WooProduct): void {
    item.date_modified_gmt = gmt(this.now());
    const parent = this.products.get(item.parent_id);
    if (parent) parent.date_modified_gmt = item.date_modified_gmt;
  }

  private require(id: number): WooProduct {
    const item = this.products.get(id);
    if (!item) throw new Error(`fake woocommerce: no product ${id}`);
    return item;
  }

  private build(input: {
    id: number;
    parent_id: number;
    type: WooProduct['type'];
    name: string;
    price: string;
    stock: number | null;
    sku: string;
    status: WooProduct['status'];
    stamp: string;
    description?: string;
    categories?: string[];
    tags?: string[];
    variations?: number[];
  }): WooProduct {
    const named = (names: string[] = []) =>
      names.map((name, i) => ({
        id: i + 1,
        name,
        slug: name.toLowerCase().replace(/\W+/g, '-'),
      }));
    return {
      id: input.id,
      parent_id: input.parent_id,
      name: input.name,
      slug: input.name.toLowerCase().replace(/\W+/g, '-'),
      type: input.type,
      status: input.status,
      description: input.description ?? '<p>Nice</p>',
      short_description: '',
      sku: input.sku,
      price: input.price,
      regular_price: input.price,
      sale_price: '',
      manage_stock: input.stock !== null,
      stock_quantity: input.stock,
      stock_status:
        input.stock === null || input.stock > 0 ? 'instock' : 'outofstock',
      categories: named(input.categories),
      tags: named(input.tags),
      images: [],
      variations: input.variations ?? [],
      date_created_gmt: input.stamp,
      date_modified_gmt: input.stamp,
    };
  }
}
