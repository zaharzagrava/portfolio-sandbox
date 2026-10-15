import type {
  WebhookOrderPaidEvent,
  WebhookOrderRefundedEvent,
  WebhookOrderStatusEvent,
  WebhookPayoutFailedEvent,
  WebhookPayoutPaidEvent,
} from '@marketplace-sandbox/contracts';
import { ApiVersion, transformForVersion } from './versioning';
import { deriveWebhookEventId, WebhookEventType } from './webhook-events';

/**
 * Mapping of other domains' events to webhook resources (S43 FR-022 to FR-024, FR-026). Pure: the source event is the
 * only input (nothing is read from another domain's table), the output is the latest shape of the resource; the
 * endpoint's pinned version is applied by `renderForVersion`. Sandbox events map to null (FR-024).
 */
type Json = Record<string, unknown>;

export interface MappedEvent {
  type: WebhookEventType;
  resource: 'order' | 'product' | 'payout';
  shopId: string;
  /** The source aggregate's version; the receiver orders and de-duplicates with it. */
  resourceVersion: number;
  object: Json;
}

/** Deterministic outbound id: the same source event for the same shop always has the same id (AS-30). */
export const webhookEventId = (sourceEventId: string, shopId: string): string =>
  deriveWebhookEventId(sourceEventId, shopId);

// ---------------------------------------------------------------- orders

/** The shops with a line or a sub-order in the paid order (null shops, i.e. platform lines, receive nothing). */
export function affectedOrderShops(order: WebhookOrderPaidEvent): string[] {
  const shops = new Set<string>();
  for (const l of order.lines) if (l.shopId) shops.add(l.shopId);
  for (const s of order.shopOrders) if (s.shopId) shops.add(s.shopId);
  return [...shops];
}

/** One shop's slice of a paid order: its lines and its subtotal only, never the buyer or another shop (FR-023). */
export function sliceOrderForShop(
  order: WebhookOrderPaidEvent,
  shopId: string,
): MappedEvent | null {
  const lines = order.lines.filter((l) => l.shopId === shopId);
  const shopOrder = order.shopOrders.find((s) => s.shopId === shopId);
  if (lines.length === 0 && !shopOrder) return null;
  const subtotal =
    shopOrder?.subtotalMinor ??
    lines.reduce((sum, l) => sum + l.lineTotalMinor, 0);
  return {
    type: 'order.paid',
    resource: 'order',
    shopId,
    resourceVersion: order.orderVersion,
    object: {
      id: order.orderId,
      object: 'order',
      shop_order_id: shopOrder?.shopOrderId ?? null,
      status: 'PAID',
      total: { amount: subtotal, currency: order.currency },
      lines: lines.map((l) => ({
        product_id: l.productId,
        title: l.title,
        quantity: l.quantity,
        unit_price: { amount: l.unitPriceMinor, currency: order.currency },
      })),
    },
  };
}

/** Cancel and refund: no amounts and no other shop's identity, an order-wide figure would reveal other shops' sales. */
export function mapOrderStatusEvent(
  type: 'order.cancelled' | 'order.refunded',
  event: WebhookOrderStatusEvent | WebhookOrderRefundedEvent,
  shopId: string,
): MappedEvent {
  return {
    type,
    resource: 'order',
    shopId,
    resourceVersion: event.orderVersion,
    object: {
      id: event.orderId,
      object: 'order',
      status: type === 'order.cancelled' ? 'CANCELLED' : 'REFUNDED',
      ...(event.reason ? { reason: event.reason } : {}),
    },
  };
}

// ---------------------------------------------------------------- products

const PRODUCT_TYPE: Record<string, WebhookEventType> = {
  'catalog.product_created': 'product.created',
  'catalog.product_updated': 'product.updated',
  'catalog.product_archived': 'product.archived',
  'catalog.product_restored': 'product.updated',
  'catalog.product_deleted': 'product.deleted',
};

interface ProductSnapshotLike {
  productId: string;
  shopId: string;
  title: string;
  priceMinor: number;
  currency: string;
  quantity: number;
  status: string;
  isSandbox: boolean;
  productVersion: number;
  changedFields: readonly string[];
}
interface ProductDeletedLike {
  productId: string;
  shopId: string;
  productVersion: number;
}

/** `catalog.product_*` full-state events; `catalog.product_changed` and anything else map to null. */
export function mapProductEvent(
  sourceType: string,
  payload: ProductSnapshotLike | ProductDeletedLike,
): MappedEvent | null {
  const type = PRODUCT_TYPE[sourceType];
  if (!type) return null;
  if (type === 'product.deleted') {
    const p = payload as ProductDeletedLike;
    return {
      type,
      resource: 'product',
      shopId: p.shopId,
      resourceVersion: p.productVersion,
      object: { id: p.productId, object: 'product' },
    };
  }
  const p = payload as ProductSnapshotLike;
  if (p.isSandbox) return null;
  return {
    type,
    resource: 'product',
    shopId: p.shopId,
    resourceVersion: p.productVersion,
    object: {
      id: p.productId,
      object: 'product',
      title: p.title,
      price: { amount: p.priceMinor, currency: p.currency },
      stock: p.quantity,
      status: p.status,
      changed_fields: [...p.changedFields],
    },
  };
}

// ---------------------------------------------------------------- payouts

/** `payout.paid` and `payout.failed`; cancelled, in-doubt and discrepancy events are ignored. */
export function mapPayoutEvent(
  sourceType: string,
  payload: WebhookPayoutPaidEvent | WebhookPayoutFailedEvent,
): MappedEvent | null {
  if (sourceType !== 'payout.paid' && sourceType !== 'payout.failed')
    return null;
  if (payload.isSandbox) return null;
  const paid = sourceType === 'payout.paid';
  const extra = payload as { transferRef?: string; failureCode?: string };
  return {
    type: sourceType,
    resource: 'payout',
    shopId: payload.shopId,
    resourceVersion: payload.payoutVersion,
    object: {
      id: payload.payoutId,
      object: 'payout',
      amount: { amount: payload.amountMinor, currency: payload.currency },
      period_start: payload.periodStart,
      status: paid ? 'paid' : 'failed',
      ...(paid && extra.transferRef ? { transfer_ref: extra.transferRef } : {}),
      ...(!paid && extra.failureCode
        ? { failure_code: extra.failureCode }
        : {}),
    },
  };
}

// ---------------------------------------------------------------- body

/**
 * Renders the latest-shape object in the version an endpoint pinned, through the one registry of S42 (the in-domain
 * `transformForVersion` until `ApiVersionService.transformResource` is exported). Payouts and pings have no change
 * between versions and come out as they went in.
 */
export function renderForVersion(
  resource: 'order' | 'product' | 'payout' | 'ping',
  object: Json,
  version: ApiVersion,
): Json {
  if (resource !== 'order' && resource !== 'product') return object;
  return transformForVersion(resource, object, version) as Json;
}

/** The exact JSON that is signed and POSTed; serialised once, these bytes never change across attempts or replays. */
export function buildWebhookMessage(input: {
  eventId: string;
  type: WebhookEventType;
  /** The source event's time. */
  created: string;
  apiVersion: ApiVersion;
  /** Null for pings. */
  resourceVersion: number | null;
  object: Json;
}): string {
  return JSON.stringify({
    id: input.eventId,
    object: 'event',
    type: input.type,
    created: input.created,
    api_version: input.apiVersion,
    resource_version: input.resourceVersion,
    data: { object: input.object },
  });
}
