import type { ProductMemberView, ProductPage, ShopProductSearchResponse } from '@marketplace-sandbox/contracts';
import type { InventoryParams, LogsParams, WebhookAttemptsParams } from './search-params';

/**
 * Request parameters and view mapping shared by the browser modules (`lib/api/seller-*.ts`) and the server readers
 * (`lib/server/seller.server.ts`), so a page seeded on the server asks the API exactly what the client later refetches.
 * No directive: both sides import it.
 */

export const INVENTORY_PAGE_SIZE = 20;
export const KEYS_PAGE_SIZE = 25;
export const LOGS_PAGE_SIZE = 20;
export const ATTEMPTS_PAGE_SIZE = 25;
export const WEBHOOKS_PAGE_SIZE = 25;
export const TEAM_PAGE_SIZE = 50;
export const SHOP_ORDERS_PAGE_SIZE = 20;

const withCursor = (cursor: string | undefined): { cursor?: string } => (cursor ? { cursor } : {});

/** One inventory row. Search rows carry no `version` (S32), so an edit reloads the member view first. */
export type InventoryRow = {
  id: string;
  title: string;
  priceMinor: number;
  currency: string;
  quantity: number;
  status: 'ACTIVE' | 'ARCHIVED';
  version?: number;
};
export type InventoryPage = { items: InventoryRow[]; nextCursor: string | null; source: 'browse' | 'search' };

/** A search text switches the list to the shop search (all statuses); otherwise it is the member browse list. */
export const isSearch = (params: InventoryParams): boolean => params.q.trim().length > 0;

export function inventoryQuery(params: InventoryParams): Record<string, string | number | boolean> {
  if (isSearch(params)) return { q: params.q.trim(), limit: INVENTORY_PAGE_SIZE, ...withCursor(params.cursor) };
  return { status: params.status, ...(params.inStock === undefined ? {} : { inStock: params.inStock }), limit: INVENTORY_PAGE_SIZE, ...withCursor(params.cursor) };
}

export function browsePage(page: ProductPage): InventoryPage {
  return {
    items: page.items.map(({ id, title, priceMinor, currency, quantity, status, version }: ProductMemberView) => ({ id, title, priceMinor, currency, quantity, status, version })),
    nextCursor: page.nextCursor,
    source: 'browse',
  };
}

export function searchPage(page: ShopProductSearchResponse): InventoryPage {
  return {
    items: page.items.map(({ id, title, priceMinor, currency, quantity, status }) => ({ id, title, priceMinor, currency, quantity, status })),
    nextCursor: page.nextCursor,
    source: 'search',
  };
}

/** Request-log filters from the URL: only what the API accepts is sent; defaults are left out. */
export function logsQuery(filters: LogsParams): Record<string, string | number> {
  return {
    limit: LOGS_PAGE_SIZE,
    ...(filters.requestId ? { requestId: filters.requestId } : {}),
    // S42's query enum is 2xx|3xx|4xx|5xx: "429" asks for 4xx and the logs view keeps only the rows with status 429.
    ...(filters.status === 'any' ? {} : { status: filters.status === '429' ? '4xx' : filters.status }),
    ...(filters.route ? { route: filters.route } : {}),
    ...(filters.keyId ? { keyId: filters.keyId } : {}),
    ...(filters.livemode === undefined ? {} : { livemode: String(filters.livemode) }),
    ...(filters.from ? { from: `${filters.from}T00:00:00.000Z` } : {}),
    ...(filters.to ? { to: `${filters.to}T23:59:59.999Z` } : {}),
    ...withCursor(filters.cursor),
  };
}

export function attemptsQuery(params: Pick<WebhookAttemptsParams, 'ok' | 'cursor'>): Record<string, string | number> {
  return { limit: ATTEMPTS_PAGE_SIZE, ...(params.ok === undefined ? {} : { ok: String(params.ok) }), ...withCursor(params.cursor) };
}

export const listQuery = (limit: number, params: { status?: string; cursor?: string }): Record<string, string | number> => ({
  limit,
  ...(params.status ? { status: params.status } : {}),
  ...withCursor(params.cursor),
});
