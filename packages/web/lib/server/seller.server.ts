import 'server-only';
import {
  apiKeyListSchema,
  apiVersionStateSchema,
  pageSchema,
  productPageSchema,
  requestLogPageSchema,
  sellerOverviewResponseSchema,
  shopInviteSchema,
  shopListItemSchema,
  shopMemberSchema,
  shopOrderPageSchema,
  shopProductSearchResponseSchema,
  shopSchema,
  usageReportSchema,
  webhookAttemptPageSchema,
  webhookEndpointPageSchema,
  webhookEndpointSchema,
  type SellerOverviewResponse,
  type ShopDto,
} from '@marketplace-sandbox/contracts';
import { isUuid, readAsMember } from '@/lib/server/member-read.server';
import type { ReadResult } from '@/lib/server/read.server';
import type { InventoryParams, LogsParams, WebhookAttemptsParams } from '@/lib/seller/search-params';
import {
  attemptsQuery,
  browsePage,
  inventoryQuery,
  isSearch,
  KEYS_PAGE_SIZE,
  listQuery,
  logsQuery,
  searchPage,
  SHOP_ORDERS_PAGE_SIZE,
  TEAM_PAGE_SIZE,
  WEBHOOKS_PAGE_SIZE,
  type InventoryPage,
} from '@/lib/seller/wire';

/**
 * Server reads of the seller pages (W04 FR-001, FR-002), all as the signed-in member through `readAsMember` (session cookie
 * only, `no-store`). A result is a value, never a throw. A shop id that is not a UUID never reaches the API and answers the
 * same `404 shop_not_found` as an unknown or foreign shop (W04 AS-85). Results seed `initialData` of the client queries; the
 * request parameters come from `lib/seller/wire.ts`, so a refetch asks the same question.
 */

const NOT_FOUND = { ok: false, status: 404, code: 'shop_not_found' } as const;
const forward = (path: string, params?: Record<string, string | number | boolean>) => {
  const query = params ? new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString() : '';
  return `/api/bff/f${path}${query ? `?${query}` : ''}`;
};
const scoped = (shopId: string, path: string, params?: Record<string, string | number | boolean>) => forward(`/shops/${shopId}${path}`, params);

const shopPage = pageSchema(shopListItemSchema);
const memberPage = pageSchema(shopMemberSchema);
const invitePage = pageSchema(shopInviteSchema);

export async function readMyShops(cursor?: string, limit = 50): Promise<ReadResult<ReturnType<typeof shopPage.parse>>> {
  return readAsMember(forward('/shops/mine', { limit, ...(cursor ? { cursor } : {}) }), shopPage);
}

export async function readShop(shopId: string): Promise<ReadResult<ShopDto>> {
  if (!isUuid(shopId)) return NOT_FOUND;
  return readAsMember(forward(`/shops/${shopId}`), shopSchema);
}

/** The composed overview (`GET /api/bff/seller/{shopId}/overview?days=`); each optional section may be missing with an `errors[]` entry. */
export async function readOverview(shopId: string, days: number): Promise<ReadResult<SellerOverviewResponse>> {
  if (!isUuid(shopId)) return NOT_FOUND;
  return readAsMember(`/api/bff/seller/${shopId}/overview?days=${days}`, sellerOverviewResponseSchema);
}

export async function readInventoryFirstPage(shopId: string, params: InventoryParams): Promise<ReadResult<InventoryPage>> {
  if (!isUuid(shopId)) return NOT_FOUND;
  if (isSearch(params)) {
    const result = await readAsMember(scoped(shopId, '/products/search', inventoryQuery(params)), shopProductSearchResponseSchema);
    return result.ok ? { ok: true, data: searchPage(result.data) } : result;
  }
  const result = await readAsMember(scoped(shopId, '/products', inventoryQuery(params)), productPageSchema);
  return result.ok ? { ok: true, data: browsePage(result.data) } : result;
}

export async function readShopOrders(shopId: string, params: { status?: string; cursor?: string }) {
  if (!isUuid(shopId)) return NOT_FOUND;
  return readAsMember(scoped(shopId, '/orders', listQuery(SHOP_ORDERS_PAGE_SIZE, params)), shopOrderPageSchema);
}

export async function readMembers(shopId: string, params: { cursor?: string }) {
  if (!isUuid(shopId)) return NOT_FOUND;
  return readAsMember(scoped(shopId, '/members', listQuery(TEAM_PAGE_SIZE, params)), memberPage);
}

export async function readInvites(shopId: string, params: { status?: string; cursor?: string }) {
  if (!isUuid(shopId)) return NOT_FOUND;
  return readAsMember(scoped(shopId, '/invites', listQuery(TEAM_PAGE_SIZE, params)), invitePage);
}

export async function readApiKeys(shopId: string, params: { cursor?: string }) {
  if (!isUuid(shopId)) return NOT_FOUND;
  return readAsMember(scoped(shopId, '/developers/keys', listQuery(KEYS_PAGE_SIZE, params)), apiKeyListSchema);
}

export async function readApiVersion(shopId: string) {
  if (!isUuid(shopId)) return NOT_FOUND;
  return readAsMember(scoped(shopId, '/developers/api-version'), apiVersionStateSchema);
}

export async function readRequestLogs(shopId: string, filters: LogsParams) {
  if (!isUuid(shopId)) return NOT_FOUND;
  return readAsMember(scoped(shopId, '/developers/logs', logsQuery(filters)), requestLogPageSchema);
}

export async function readUsage(shopId: string, params: { days: number; livemode: boolean }) {
  if (!isUuid(shopId)) return NOT_FOUND;
  return readAsMember(scoped(shopId, '/developers/usage', { days: params.days, livemode: String(params.livemode) }), usageReportSchema);
}

export async function readWebhooks(shopId: string, params: { cursor?: string }) {
  if (!isUuid(shopId)) return NOT_FOUND;
  return readAsMember(scoped(shopId, '/developers/webhooks', listQuery(WEBHOOKS_PAGE_SIZE, params)), webhookEndpointPageSchema);
}

export async function readWebhook(shopId: string, endpointId: string) {
  if (!isUuid(shopId)) return NOT_FOUND;
  return readAsMember(scoped(shopId, `/developers/webhooks/${encodeURIComponent(endpointId)}`), webhookEndpointSchema);
}

export async function readWebhookAttempts(shopId: string, endpointId: string, params: WebhookAttemptsParams) {
  if (!isUuid(shopId)) return NOT_FOUND;
  return readAsMember(scoped(shopId, `/developers/webhooks/${encodeURIComponent(endpointId)}/attempts`, attemptsQuery(params)), webhookAttemptPageSchema);
}
