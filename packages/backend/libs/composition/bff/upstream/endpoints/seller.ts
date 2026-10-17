import { z } from 'zod';
import {
  dashboardTodaySchema,
  sellerStatsSchema,
  shopRankSchema,
  shopSchema,
} from '@marketplace-sandbox/contracts';
import { Endpoint, enc } from './endpoint';

/** S03 `GET /api/shops/:shopId` as the caller: `404 shop_not_found` for a non-member, unknown or foreign shop. */
export const shopById = (
  shopId: string,
): Endpoint<z.infer<typeof shopSchema>> => ({
  name: 'seller_shop',
  upstream: 'tenancy',
  method: 'GET',
  path: `/api/shops/${enc(shopId)}`,
  schema: shopSchema,
  identity: 'required',
  sharedCache: false,
  breaker: false,
});

/** S40 `GET /api/shops/:shopId/stats?days=` (members only). */
export const shopStats = (
  shopId: string,
  days: number,
): Endpoint<z.infer<typeof sellerStatsSchema>> => ({
  name: 'seller_stats',
  upstream: 'seller-insights',
  method: 'GET',
  path: `/api/shops/${enc(shopId)}/stats`,
  query: { days: String(days) },
  schema: sellerStatsSchema,
  identity: 'required',
  sharedCache: false,
  breaker: false,
});

/** S40 `GET /api/shops/:shopId/dashboard/today`. */
export const shopDashboardToday = (
  shopId: string,
): Endpoint<z.infer<typeof dashboardTodaySchema>> => ({
  name: 'seller_today',
  upstream: 'seller-insights',
  method: 'GET',
  path: `/api/shops/${enc(shopId)}/dashboard/today`,
  schema: dashboardTodaySchema,
  identity: 'required',
  sharedCache: false,
  breaker: false,
});

/** S40 `GET /api/shops/:shopId/rank`: `404 not_ranked` while the shop has no rank yet. */
export const shopRank = (
  shopId: string,
): Endpoint<z.infer<typeof shopRankSchema>> => ({
  name: 'seller_rank',
  upstream: 'seller-insights',
  method: 'GET',
  path: `/api/shops/${enc(shopId)}/rank`,
  schema: shopRankSchema,
  identity: 'required',
  sharedCache: false,
  breaker: false,
});
