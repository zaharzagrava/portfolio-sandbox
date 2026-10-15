import { createHmac, timingSafeEqual } from 'node:crypto';
import { Clock, SystemClock } from '@app/common/core/clock';
import { idString, isRecord } from '../domain/normalise';
import { normaliseShopifyProduct } from '../domain/normalise-shopify';
import {
  ProviderCallError,
  type CommerceProvider,
  type ConnectionFacts,
  type OAuthTokens,
  type Page,
  type ParsedWebhook,
  type ProviderSession,
  type RawItem,
  type RegisteredWebhooks,
  type RemoteDigest,
  type StockWriteOutcome,
  type SyncSession,
  type WebhookHeaders,
  type WebhookSubscription,
} from '../domain/ports/commerce-provider.port';
import { validateShopifyDomain } from '../domain/store-address';
import { verifyHmacSha256Base64 } from '../domain/webhook-verify';

export const SHOPIFY_SCOPES =
  'read_products,read_inventory,write_inventory,read_locations';
export const SHOPIFY_WEBHOOK_TOPICS = [
  'products/update',
  'products/delete',
  'inventory_levels/update',
  'app/uninstalled',
] as const;
const PAGE_SIZE = 250;
/** Shopify allows at most 50 inventory item ids per `inventory_levels` read. */
const LEVEL_CHUNK = 50;
const CALLBACK_TOLERANCE_MS = 300_000;

export interface ShopifyAdapterOptions {
  appKey: string;
  appSecret: string;
  /** Pinned Admin API version (configuration `SHOPIFY_API_VERSION`). */
  apiVersion: string;
  clock?: Clock;
}

const header = (headers: WebhookHeaders, name: string): string | undefined => {
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === name)
      return Array.isArray(value) ? value[0] : value;
  return undefined;
};

const isId = (v: string): boolean => /^[A-Za-z0-9_-]+$/.test(v);

/**
 * Shopify Admin REST adapter (T014, FR-001, AS-03, AS-12, AS-36..AS-38, AS-54). Speaks only through the session's
 * `ProviderCallPolicy`, so every call is rate-limited, breaker-guarded, SSRF-safe and validated by the call stack.
 */
export class ShopifyAdapter implements CommerceProvider {
  readonly name = 'shopify' as const;
  private readonly clock: Clock;

  constructor(private readonly options: ShopifyAdapterOptions) {
    this.clock = options.clock ?? new SystemClock();
  }

  /** Origin and API root of a store, for building the call stack. */
  apiTarget(shopDomain: string): { origin: string; apiPath: string } {
    return {
      origin: `https://${shopDomain}`,
      apiPath: `/admin/api/${this.options.apiVersion}`,
    };
  }

  // ---- OAuth -----------------------------------------------------------------------------------------------------

  buildAuthorizeUrl(input: {
    shopDomain: string;
    state: string;
    redirectUri: string;
  }): string {
    const url = new URL(`https://${input.shopDomain}/admin/oauth/authorize`);
    url.searchParams.set('client_id', this.options.appKey);
    url.searchParams.set('scope', SHOPIFY_SCOPES);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    return url.toString();
  }

  verifyCallback(
    query: Record<string, string>,
    now: Date,
  ): { shop: string; code: string; state: string } | null {
    const { hmac, shop, code, state, timestamp } = query;
    if (
      [hmac, shop, code, state, timestamp].some(
        (v) => typeof v !== 'string' || v === '',
      )
    )
      return null;
    const message = Object.keys(query)
      .filter((k) => k !== 'hmac')
      .sort()
      .map((k) => `${k}=${query[k]}`)
      .join('&');
    const expected = Buffer.from(
      createHmac('sha256', this.options.appSecret)
        .update(message)
        .digest('hex'),
      'utf8',
    );
    const given = Buffer.from(hmac, 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return null;
    if (!/^\d{1,12}$/.test(timestamp)) return null;
    if (
      Math.abs(now.getTime() - Number(timestamp) * 1000) > CALLBACK_TOLERANCE_MS
    )
      return null;
    const domain = validateShopifyDomain(shop);
    return domain.ok ? { shop: domain.domain, code, state } : null;
  }

  async exchangeCode(
    session: ProviderSession,
    input: { shopDomain: string; code: string },
  ): Promise<OAuthTokens> {
    return this.tokenRequest(session, {
      client_id: this.options.appKey,
      client_secret: this.options.appSecret,
      code: input.code,
      expiring: 1,
    });
  }

  async refreshToken(
    session: ProviderSession,
    input: { refreshToken: string },
  ): Promise<OAuthTokens | null> {
    try {
      return await this.tokenRequest(session, {
        client_id: this.options.appKey,
        client_secret: this.options.appSecret,
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
      });
    } catch (error) {
      if (
        error instanceof ProviderCallError &&
        (error.kind === 'rejected' || error.kind === 'auth_failed')
      )
        return null;
      throw error;
    }
  }

  private async tokenRequest(
    session: ProviderSession,
    body: Record<string, unknown>,
  ): Promise<OAuthTokens> {
    // The code is single use: never retried (idempotent: false).
    const res = await session.call.call({
      method: 'POST',
      scope: 'origin',
      path: '/admin/oauth/access_token',
      auth: false,
      body,
      idempotent: false,
      validate: (j) =>
        isRecord(j) &&
        typeof j.access_token === 'string' &&
        j.access_token !== '',
    });
    const json = res.json as Record<string, unknown>;
    const expiresIn =
      typeof json.expires_in === 'number' ? json.expires_in : undefined;
    return {
      accessToken: json.access_token as string,
      scope: typeof json.scope === 'string' ? json.scope : '',
      ...(typeof json.refresh_token === 'string'
        ? { refreshToken: json.refresh_token }
        : {}),
      ...(expiresIn !== undefined
        ? { expiresAt: new Date(this.clock.nowMs() + expiresIn * 1000) }
        : {}),
    };
  }

  // ---- connection facts ------------------------------------------------------------------------------------------

  async verifyCredentials(session: ProviderSession): Promise<ConnectionFacts> {
    const res = await session.call.call({
      method: 'GET',
      path: '/shop.json',
      idempotent: true,
      validate: (j) =>
        isRecord(j) && isRecord(j.shop) && typeof j.shop.currency === 'string',
    });
    const shop = (res.json as { shop: Record<string, unknown> }).shop;
    const currency = (shop.currency as string).toUpperCase();
    let locationId = idString(shop.primary_location_id);
    if (locationId === null) {
      const locations = await session.call.call({
        method: 'GET',
        path: '/locations.json',
        idempotent: true,
        validate: (j) => isRecord(j) && Array.isArray(j.locations),
      });
      const active = (
        (locations.json as { locations: unknown[] }).locations ?? []
      ).find(
        (l) => isRecord(l) && l.active !== false && idString(l.id) !== null,
      );
      locationId = active && isRecord(active) ? idString(active.id) : null;
    }
    if (locationId === null) throw new ProviderCallError('schema_invalid');
    return { currency, locationId };
  }

  // ---- catalog reads ---------------------------------------------------------------------------------------------

  async listChanged(
    session: SyncSession,
    input: { since: Date | null; pageCursor: string | null },
  ): Promise<Page<RawItem>> {
    // With `page_info` Shopify forbids every other filter: the cursor carries the original query.
    const query: Record<string, string | number> = input.pageCursor
      ? { limit: PAGE_SIZE, page_info: input.pageCursor }
      : {
          limit: PAGE_SIZE,
          ...(input.since ? { updated_at_min: input.since.toISOString() } : {}),
        };
    const { products, next } = await this.productsPage(session, query);
    return { items: this.toItems(session, products), nextCursor: next };
  }

  async listAllIdsAndDigests(
    session: SyncSession,
    input: { pageCursor: string | null },
  ): Promise<Page<RemoteDigest>> {
    const page = await this.listChanged(session, {
      since: null,
      pageCursor: input.pageCursor,
    });
    const items: RemoteDigest[] = [];
    for (const raw of page.items)
      for (const r of raw.results)
        if (r.ok)
          items.push({
            externalId: r.item.externalId,
            digest: r.item.contentDigest,
            stock: r.item.stock,
          });
    return { items, nextCursor: page.nextCursor };
  }

  async fetchOne(
    session: SyncSession,
    externalId: string,
  ): Promise<RawItem | null> {
    const [productId] = externalId.split(':');
    if (!isId(productId)) return null;
    let product: Record<string, unknown>;
    try {
      product = await this.productById(session, productId);
    } catch (error) {
      if (error instanceof ProviderCallError && error.kind === 'gone')
        return null;
      throw error;
    }
    const [overlaid] = await this.overlayStock(session, [product]);
    return this.toItems(session, [overlaid])[0];
  }

  private async productsPage(
    session: SyncSession,
    query: Record<string, string | number>,
  ): Promise<{ products: Record<string, unknown>[]; next: string | null }> {
    const res = await session.call.call({
      method: 'GET',
      path: '/products.json',
      query,
      idempotent: true,
      validate: (j) =>
        isRecord(j) && Array.isArray(j.products) && j.products.every(isRecord),
    });
    const products = (res.json as { products: Record<string, unknown>[] })
      .products;
    return {
      products: await this.overlayStock(session, products),
      next: res.nextUrl?.searchParams.get('page_info') ?? null,
    };
  }

  private async productById(
    session: SyncSession,
    productId: string,
  ): Promise<Record<string, unknown>> {
    const res = await session.call.call({
      method: 'GET',
      path: `/products/${productId}.json`,
      idempotent: true,
      validate: (j) => isRecord(j) && isRecord(j.product),
    });
    return (res.json as { product: Record<string, unknown> }).product;
  }

  /** Variant stock = the level at the integration's location (`inventory_quantity` sums all locations). */
  private async overlayStock(
    session: SyncSession,
    products: Record<string, unknown>[],
  ): Promise<Record<string, unknown>[]> {
    const tracked = new Set<string>();
    for (const p of products)
      for (const v of Array.isArray(p.variants) ? p.variants : [])
        if (isRecord(v) && v.inventory_management != null) {
          const id = idString(v.inventory_item_id);
          if (id !== null) tracked.add(id);
        }
    if (tracked.size === 0) return products;
    if (!session.locationId)
      throw new Error('Shopify stock read needs the integration location');

    const levels = new Map<string, number>();
    const ids = [...tracked];
    for (let i = 0; i < ids.length; i += LEVEL_CHUNK) {
      const res = await session.call.call({
        method: 'GET',
        path: '/inventory_levels.json',
        query: {
          inventory_item_ids: ids.slice(i, i + LEVEL_CHUNK).join(','),
          location_ids: session.locationId,
          limit: PAGE_SIZE,
        },
        idempotent: true,
        validate: (j) =>
          isRecord(j) &&
          Array.isArray(j.inventory_levels) &&
          j.inventory_levels.every(isRecord),
      });
      for (const level of (
        res.json as { inventory_levels: Record<string, unknown>[] }
      ).inventory_levels) {
        const item = idString(level.inventory_item_id);
        const location =
          level.location_id === undefined
            ? session.locationId
            : idString(level.location_id);
        if (
          item !== null &&
          location === session.locationId &&
          typeof level.available === 'number'
        )
          levels.set(item, level.available);
      }
    }

    return products.map((p) => ({
      ...p,
      variants: (Array.isArray(p.variants) ? p.variants : []).map(
        (v: unknown) => {
          if (!isRecord(v) || v.inventory_management == null) return v;
          const { inventory_quantity: _total, ...rest } = v;
          const level = levels.get(idString(v.inventory_item_id) ?? '');
          return level === undefined
            ? rest
            : { ...rest, inventory_quantity: level };
        },
      ),
    }));
  }

  private toItems(
    session: SyncSession,
    products: Record<string, unknown>[],
  ): RawItem[] {
    return products.map((product) => ({
      productId: idString(product.id) ?? '',
      raw: product,
      results: normaliseShopifyProduct(product, session.normalise),
    }));
  }

  // ---- stock write -----------------------------------------------------------------------------------------------

  async setStock(
    session: SyncSession,
    externalId: string,
    value: number,
    expected: number,
  ): Promise<StockWriteOutcome> {
    const [productId, variantId] = externalId.split(':');
    if (!productId || !variantId || !isId(productId) || !isId(variantId))
      throw new Error('Shopify stock writes need <productId>:<variantId>');
    if (!session.locationId)
      throw new Error('Shopify stock write needs the integration location');

    let product: Record<string, unknown>;
    try {
      product = await this.productById(session, productId);
    } catch (error) {
      if (error instanceof ProviderCallError && error.kind === 'gone')
        return 'gone';
      throw error;
    }
    const variant = (
      Array.isArray(product.variants) ? product.variants : []
    ).find((v: unknown) => isRecord(v) && idString(v.id) === variantId) as
      Record<string, unknown> | undefined;
    const itemId = variant ? idString(variant.inventory_item_id) : null;
    if (itemId === null) return 'gone';

    try {
      // Absolute set conditional on the level we last agreed on: a concurrent seller edit makes it fail (AS-37).
      await session.call.call({
        method: 'POST',
        path: '/inventory_levels/set.json',
        body: {
          location_id: Number(session.locationId),
          inventory_item_id: Number(itemId),
          available: value,
          change_from_quantity: expected,
        },
        idempotent: true,
        validate: (j) => isRecord(j) && isRecord(j.inventory_level),
      });
      return 'accepted';
    } catch (error) {
      if (!(error instanceof ProviderCallError)) throw error;
      if (error.kind === 'gone') return 'gone';
      if (error.kind !== 'rejected' || error.status !== 422) throw error;
    }
    // 422: the level changed since we read it. A retried write that already landed also looks like this: read back.
    const level = await this.levelOf(session, itemId);
    if (level === null) return 'gone';
    return level === value ? 'accepted' : 'precondition_failed';
  }

  private async levelOf(
    session: SyncSession,
    itemId: string,
  ): Promise<number | null> {
    const res = await session.call.call({
      method: 'GET',
      path: '/inventory_levels.json',
      query: { inventory_item_ids: itemId, location_ids: session.locationId },
      idempotent: true,
      validate: (j) => isRecord(j) && Array.isArray(j.inventory_levels),
    });
    const level = (
      res.json as { inventory_levels: Record<string, unknown>[] }
    ).inventory_levels.find((l) => idString(l.inventory_item_id) === itemId);
    return level && typeof level.available === 'number'
      ? level.available
      : null;
  }

  // ---- webhooks --------------------------------------------------------------------------------------------------

  async registerWebhooks(
    session: ProviderSession,
    input: { callbackUrl: string },
  ): Promise<RegisteredWebhooks> {
    const subscriptions: WebhookSubscription[] = [];
    try {
      for (const topic of SHOPIFY_WEBHOOK_TOPICS)
        subscriptions.push({
          topic,
          id: await this.subscribe(session, topic, input.callbackUrl),
        });
    } catch (error) {
      await this.deregisterWebhooks(session, subscriptions).catch(
        () => undefined,
      );
      throw error;
    }
    return { subscriptions, webhookSecret: null };
  }

  private async subscribe(
    session: ProviderSession,
    topic: string,
    address: string,
  ): Promise<string> {
    try {
      // Creating a subscription is not idempotent: never retried automatically (AS-57).
      const res = await session.call.call({
        method: 'POST',
        path: '/webhooks.json',
        body: { webhook: { topic, address, format: 'json' } },
        idempotent: false,
        validate: (j) =>
          isRecord(j) && isRecord(j.webhook) && idString(j.webhook.id) !== null,
      });
      return idString((res.json as { webhook: { id: unknown } }).webhook.id)!;
    } catch (error) {
      if (
        !(error instanceof ProviderCallError) ||
        error.kind !== 'rejected' ||
        error.status !== 422
      )
        throw error;
    }
    // "already taken" (a repeated connect): reuse the existing subscription.
    const res = await session.call.call({
      method: 'GET',
      path: '/webhooks.json',
      idempotent: true,
      validate: (j) => isRecord(j) && Array.isArray(j.webhooks),
    });
    const existing = (
      res.json as { webhooks: Record<string, unknown>[] }
    ).webhooks.find((w) => w.topic === topic && w.address === address);
    const id = existing ? idString(existing.id) : null;
    if (id === null) throw new ProviderCallError('rejected', { status: 422 });
    return id;
  }

  async deregisterWebhooks(
    session: ProviderSession,
    subscriptions: WebhookSubscription[],
  ): Promise<void> {
    let failure: unknown;
    for (const subscription of subscriptions) {
      if (!isId(subscription.id)) continue;
      try {
        await session.call.call({
          method: 'DELETE',
          path: `/webhooks/${subscription.id}.json`,
          idempotent: true,
        });
      } catch (error) {
        if (error instanceof ProviderCallError && error.kind === 'gone')
          continue;
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  async deregisterWebhooksAt(
    session: ProviderSession,
    input: { callbackUrl: string },
  ): Promise<void> {
    const res = await session.call.call({
      method: 'GET',
      path: '/webhooks.json',
      idempotent: true,
      validate: (j) =>
        isRecord(j) && Array.isArray(j.webhooks) && j.webhooks.every(isRecord),
    });
    const ours = (res.json as { webhooks: Record<string, unknown>[] }).webhooks
      .filter((w) => w.address === input.callbackUrl && idString(w.id) !== null)
      .map((w) => ({
        topic: typeof w.topic === 'string' ? w.topic : '',
        id: idString(w.id)!,
      }));
    await this.deregisterWebhooks(session, ours);
  }

  /** Shopify signs every webhook with the app secret; a per-integration `secret` argument is ignored on purpose. */
  verifyWebhook(
    headers: WebhookHeaders,
    rawBody: Buffer,
    _secret?: string,
  ): boolean {
    return verifyHmacSha256Base64(
      this.options.appSecret,
      rawBody,
      header(headers, 'x-shopify-hmac-sha256'),
    );
  }

  parseWebhook(headers: WebhookHeaders, rawBody: Buffer): ParsedWebhook | null {
    const rawTopic = header(headers, 'x-shopify-topic');
    const deliveryId =
      header(headers, 'x-shopify-webhook-id') ??
      header(headers, 'x-shopify-event-id');
    if (!rawTopic || !deliveryId) return null;
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return null;
    }
    if (!isRecord(body)) return null;
    const triggeredAt = header(headers, 'x-shopify-triggered-at');
    if (triggeredAt !== undefined && Number.isNaN(Date.parse(triggeredAt)))
      return null;
    const base = {
      rawTopic,
      deliveryId,
      ...(triggeredAt ? { triggeredAt } : {}),
    };
    switch (rawTopic) {
      case 'products/create':
      case 'products/update':
      case 'products/delete': {
        const externalId = idString(body.id);
        if (externalId === null) return null;
        return {
          ...base,
          topic:
            rawTopic === 'products/delete'
              ? 'product_deleted'
              : 'product_changed',
          externalId,
        };
      }
      case 'inventory_levels/update': {
        const inventoryItemId = idString(body.inventory_item_id);
        if (inventoryItemId === null) return null;
        return { ...base, topic: 'inventory_changed', inventoryItemId };
      }
      case 'app/uninstalled':
        return { ...base, topic: 'app_uninstalled' };
      default:
        return { ...base, topic: 'ignored' };
    }
  }
}
