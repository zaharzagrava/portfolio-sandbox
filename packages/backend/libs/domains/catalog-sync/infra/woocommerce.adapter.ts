import { randomBytes } from 'node:crypto';
import {
  idString,
  isRecord,
  reject,
  type NormaliseResult,
} from '../domain/normalise';
import { normaliseWooProduct } from '../domain/normalise-woocommerce';
import {
  ProviderCallError,
  type CommerceProvider,
  type ConnectionFacts,
  type Page,
  type ParsedWebhook,
  type ProviderAuth,
  type ProviderSession,
  type RawItem,
  type RegisteredWebhooks,
  type RemoteDigest,
  type StockWriteOutcome,
  type SyncSession,
  type WebhookHeaders,
  type WebhookSubscription,
} from '../domain/ports/commerce-provider.port';
import { verifyHmacSha256Base64 } from '../domain/webhook-verify';

export const WOO_WEBHOOK_TOPICS = [
  'product.created',
  'product.updated',
  'product.deleted',
] as const;
const PAGE_SIZE = 100;
/** A variable product with more variation pages than this is cut off (the page is still valid; the rest is quarantine-visible). */
const MAX_VARIATION_PAGES = 50;

const header = (headers: WebhookHeaders, name: string): string | undefined => {
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === name)
      return Array.isArray(value) ? value[0] : value;
  return undefined;
};

const isId = (v: string): boolean => /^[0-9]+$/.test(v);

/** HTTP Basic credential of a WooCommerce key pair; `tokenId` is a fingerprint of the key (not the secret). */
export function wooBasicAuth(
  consumerKey: string,
  consumerSecret: string,
): ProviderAuth {
  const authorization = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`;
  return {
    // eslint-disable-next-line @typescript-eslint/require-await -- port contract is async
    current: async () => ({ headers: { authorization }, tokenId: consumerKey }),
  };
}

/**
 * WooCommerce REST v3 adapter (T014, FR-002, AS-06, AS-12, AS-33, AS-36..AS-38). Authentication and the shared limiter,
 * breaker and SSRF guard come from the session's `ProviderCallPolicy`. WooCommerce has no compare-and-set on stock:
 * `setStock` is read, re-read, write, verify (the window that remains is documented in the method).
 */
export class WooCommerceAdapter implements CommerceProvider {
  readonly name = 'woocommerce' as const;

  /** Origin and API root of a store (`storeUrl` already passed `validateStoreUrl`). */
  apiTarget(storeUrl: string): { origin: string; apiPath: string } {
    const url = new URL(storeUrl);
    return {
      origin: url.origin,
      apiPath: `${url.pathname.replace(/\/+$/, '')}/wp-json/wc/v3`,
    };
  }

  async verifyCredentials(session: ProviderSession): Promise<ConnectionFacts> {
    // One authenticated read that also proves the key can read the shop settings.
    const res = await session.call.call({
      method: 'GET',
      path: '/settings/general/woocommerce_currency',
      idempotent: true,
      validate: (j) =>
        isRecord(j) && typeof j.value === 'string' && j.value !== '',
    });
    return {
      currency: (res.json as { value: string }).value.toUpperCase(),
      locationId: null,
    };
  }

  // ---- catalog reads ---------------------------------------------------------------------------------------------

  async listChanged(
    session: SyncSession,
    input: { since: Date | null; pageCursor: string | null },
  ): Promise<Page<RawItem>> {
    const page = input.pageCursor ?? '1';
    if (!/^[1-9]\d{0,5}$/.test(page))
      throw new ProviderCallError('schema_invalid');
    const res = await session.call.call({
      method: 'GET',
      path: '/products',
      query: {
        per_page: PAGE_SIZE,
        page,
        dates_are_gmt: 'true',
        ...(input.since ? { modified_after: input.since.toISOString() } : {}),
      },
      idempotent: true,
      validate: (j) => Array.isArray(j) && j.every(isRecord),
    });
    const products = res.json as Record<string, unknown>[];
    const items: RawItem[] = [];
    for (const product of products)
      items.push(await this.expand(session, product));
    return { items, nextCursor: res.nextUrl?.searchParams.get('page') ?? null };
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
    const [parentId, childId] = externalId.split(':');
    if (!isId(parentId) || (childId !== undefined && !isId(childId)))
      return null;
    try {
      const parent = await this.get(session, `/products/${parentId}`);
      if (childId === undefined || childId === parentId)
        return await this.expand(session, parent);
      const variation = await this.get(
        session,
        `/products/${parentId}/variations/${childId}`,
      );
      return this.build(session, parent, [variation]);
    } catch (error) {
      if (error instanceof ProviderCallError && error.kind === 'gone')
        return null;
      throw error;
    }
  }

  private async get(
    session: SyncSession,
    path: string,
  ): Promise<Record<string, unknown>> {
    const res = await session.call.call({
      method: 'GET',
      path,
      idempotent: true,
      validate: (j) => isRecord(j) && idString(j.id) !== null,
    });
    return res.json as Record<string, unknown>;
  }

  /** A variable product becomes one result per variation; any other product one result. */
  private async expand(
    session: SyncSession,
    product: Record<string, unknown>,
  ): Promise<RawItem> {
    if (product.type !== 'variable') return this.build(session, product, null);
    const id = idString(product.id);
    if (id === null) return this.build(session, product, null);
    const variations: Record<string, unknown>[] = [];
    let page = '1';
    for (let i = 0; i < MAX_VARIATION_PAGES; i++) {
      const res = await session.call.call({
        method: 'GET',
        path: `/products/${id}/variations`,
        query: { per_page: PAGE_SIZE, page },
        idempotent: true,
        validate: (j) => Array.isArray(j) && j.every(isRecord),
      });
      variations.push(...(res.json as Record<string, unknown>[]));
      const next = res.nextUrl?.searchParams.get('page');
      if (!next) break;
      page = next;
    }
    return this.build(session, product, variations);
  }

  private build(
    session: SyncSession,
    product: Record<string, unknown>,
    variations: Record<string, unknown>[] | null,
  ): RawItem {
    const productId = idString(product.id) ?? '';
    let results: NormaliseResult[];
    if (variations === null)
      results = normaliseWooProduct(product, session.normalise);
    else if (product.status !== 'publish')
      results = variations.map((v) =>
        reject('unlisted', `${productId}:${idString(v.id) ?? ''}`),
      );
    else
      results = variations.flatMap((v) =>
        normaliseWooProduct(v, session.normalise, product),
      );
    return {
      productId,
      raw:
        variations === null ? product : { ...product, _variations: variations },
      results,
    };
  }

  // ---- stock write -----------------------------------------------------------------------------------------------

  /**
   * WooCommerce has no conditional write. Read the item, compare with `expected`; read it again right before the
   * write and require the same quantity and `date_modified_gmt`; write; accept only when the answer holds `value`.
   * A seller edit landing between the second read and the write is still overwritten (no provider primitive closes
   * that window); the next pull and the nightly reconciliation detect it.
   */
  async setStock(
    session: SyncSession,
    externalId: string,
    value: number,
    expected: number,
  ): Promise<StockWriteOutcome> {
    const [parentId, childId] = externalId.split(':');
    if (!parentId || !childId || !isId(parentId) || !isId(childId))
      throw new Error('WooCommerce stock writes need <productId>:<variantId>');
    const path =
      parentId === childId
        ? `/products/${parentId}`
        : `/products/${parentId}/variations/${childId}`;
    const matches = (item: Record<string, unknown>) =>
      item.manage_stock === true && item.stock_quantity === expected;

    try {
      const first = await this.get(session, path);
      if (!matches(first)) return 'precondition_failed';
      const second = await this.get(session, path);
      if (
        !matches(second) ||
        second.date_modified_gmt !== first.date_modified_gmt
      )
        return 'precondition_failed';
      const res = await session.call.call({
        method: 'PUT',
        path,
        body: { manage_stock: true, stock_quantity: value },
        idempotent: true,
        validate: (j) => isRecord(j) && idString(j.id) !== null,
      });
      return (res.json as { stock_quantity?: unknown }).stock_quantity === value
        ? 'accepted'
        : 'precondition_failed';
    } catch (error) {
      if (error instanceof ProviderCallError && error.kind === 'gone')
        return 'gone';
      throw error;
    }
  }

  // ---- webhooks --------------------------------------------------------------------------------------------------

  async registerWebhooks(
    session: ProviderSession,
    input: { callbackUrl: string; secret?: string },
  ): Promise<RegisteredWebhooks> {
    const secret = input.secret ?? randomBytes(32).toString('hex');
    // A repeated connect replaces the earlier subscriptions that point at the same URL (their secret is lost).
    const listed = await session.call.call({
      method: 'GET',
      path: '/webhooks',
      query: { per_page: PAGE_SIZE },
      idempotent: true,
      validate: (j) => Array.isArray(j) && j.every(isRecord),
    });
    const stale = (listed.json as Record<string, unknown>[])
      .filter(
        (w) => w.delivery_url === input.callbackUrl && idString(w.id) !== null,
      )
      .map((w) => ({
        topic: typeof w.topic === 'string' ? w.topic : '',
        id: idString(w.id)!,
      }));
    await this.deregisterWebhooks(session, stale);

    const subscriptions: WebhookSubscription[] = [];
    try {
      for (const topic of WOO_WEBHOOK_TOPICS) {
        // Creating a subscription is not idempotent: never retried automatically (AS-57).
        const res = await session.call.call({
          method: 'POST',
          path: '/webhooks',
          body: {
            name: `Marketplace ${topic}`,
            topic,
            delivery_url: input.callbackUrl,
            secret,
            status: 'active',
          },
          idempotent: false,
          validate: (j) => isRecord(j) && idString(j.id) !== null,
        });
        subscriptions.push({
          topic,
          id: idString((res.json as { id: unknown }).id)!,
        });
      }
    } catch (error) {
      await this.deregisterWebhooks(session, subscriptions).catch(
        () => undefined,
      );
      throw error;
    }
    return { subscriptions, webhookSecret: secret };
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
          path: `/webhooks/${subscription.id}`,
          query: { force: 'true' },
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
    const listed = await session.call.call({
      method: 'GET',
      path: '/webhooks',
      query: { per_page: PAGE_SIZE },
      idempotent: true,
      validate: (j) => Array.isArray(j) && j.every(isRecord),
    });
    const ours = (listed.json as Record<string, unknown>[])
      .filter(
        (w) => w.delivery_url === input.callbackUrl && idString(w.id) !== null,
      )
      .map((w) => ({
        topic: typeof w.topic === 'string' ? w.topic : '',
        id: idString(w.id)!,
      }));
    await this.deregisterWebhooks(session, ours);
  }

  verifyWebhook(
    headers: WebhookHeaders,
    rawBody: Buffer,
    secret?: string,
  ): boolean {
    return verifyHmacSha256Base64(
      secret ?? '',
      rawBody,
      header(headers, 'x-wc-webhook-signature'),
    );
  }

  parseWebhook(headers: WebhookHeaders, rawBody: Buffer): ParsedWebhook | null {
    const text = rawBody.toString('utf8');
    const rawTopic = header(headers, 'x-wc-webhook-topic');
    const deliveryId = header(headers, 'x-wc-webhook-delivery-id');

    // The registration ping is a form-encoded body with only `webhook_id`.
    const ping = /^webhook_id=(\d+)$/.exec(text.trim());
    if (ping)
      return {
        topic: 'ping',
        rawTopic: rawTopic ?? 'ping',
        deliveryId: deliveryId ?? `ping:${ping[1]}`,
      };

    if (!rawTopic || !deliveryId) return null;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isRecord(body)) return null;
    const base = { rawTopic, deliveryId };
    if (!rawTopic.startsWith('product.')) return { ...base, topic: 'ignored' };
    const id = idString(body.id);
    if (id === null) return null;
    const parent = idString(body.parent_id);
    const externalId =
      parent !== null && parent !== '0' ? `${parent}:${id}` : id;
    return {
      ...base,
      topic:
        rawTopic === 'product.deleted' ? 'product_deleted' : 'product_changed',
      externalId,
    };
  }
}
