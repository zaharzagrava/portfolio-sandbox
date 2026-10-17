import { http, HttpResponse } from 'msw';
import {
  liveDashboardFrameSchema,
  problemDetailsSchema,
  sellerOverviewResponseSchema,
  shopListItemSchema,
  shopSchema,
  type LiveDashboardFrame,
  type SellerOverviewResponse,
} from '@marketplace-sandbox/contracts';

/**
 * W04 test fixtures. Every success body is parsed with its contract schema when it is built and every problem body with
 * `problemDetailsSchema`, so a fixture that drifts from the wire shape fails loudly (test-plan "UI unit").
 */

export const origin = 'http://localhost:3000';
export const SELLER_SHOP_ID = '7c1d9a2e-0b3f-4c5d-8e6f-2a3b4c5d6e7f';
export const OTHER_SHOP_ID = '2d9e8f7a-6b5c-4d3e-9f10-a1b2c3d4e5f6';
export const SELLER_PRODUCT_ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';

export const ALL_PERMISSIONS = [
  'shop.read', 'shop.manage', 'shop.delete', 'shop.export', 'members.read', 'members.manage', 'products.read', 'products.write',
  'orders.read', 'orders.manage', 'payouts.read', 'billing.manage', 'api-keys.manage', 'webhooks.manage', 'integrations.manage',
  'widget.manage', 'sso.manage',
] as const;
export const VIEWER_PERMISSIONS = ['shop.read', 'members.read', 'products.read', 'orders.read'] as const;

export function shopFixture(overrides: Record<string, unknown> = {}) {
  return shopSchema.parse({
    id: SELLER_SHOP_ID,
    name: 'Clay Works',
    slug: 'clay-works',
    plan: 'STARTER',
    status: 'ACTIVE',
    verificationStatus: 'UNVERIFIED',
    payoutsEnabled: false,
    region: 'eu',
    shopVersion: 1,
    createdAt: '2026-10-01T09:00:00.000Z',
    purgeAt: null,
    myRole: 'OWNER',
    myPermissions: [...ALL_PERMISSIONS],
    ...overrides,
  });
}

export function shopListItemFixture(overrides: Record<string, unknown> = {}) {
  return shopListItemSchema.parse({ id: SELLER_SHOP_ID, name: 'Clay Works', slug: 'clay-works', plan: 'STARTER', status: 'ACTIVE', role: 'OWNER', ...overrides });
}

export function overviewFixture(overrides: Record<string, unknown> = {}): SellerOverviewResponse {
  return sellerOverviewResponseSchema.parse({
    shop: shopFixture(),
    stats: {
      shopId: SELLER_SHOP_ID,
      days: 30,
      from: '2026-09-18',
      to: '2026-10-17',
      currency: 'EUR',
      summary: { revenueMinor: 125050, orders: 12, unitsSold: 20, uniqueBuyers: 9, refundsCount: 1, refundedMinor: 2500, netRevenueMinor: 122550, avgOrderValueMinor: 10421 },
      daily: [
        { day: '2026-10-16', revenueMinor: 5000, orders: 1, refundedMinor: 0 },
        { day: '2026-10-17', revenueMinor: 20050, orders: 3, refundedMinor: 2500 },
      ],
      topProducts: [{ productId: SELLER_PRODUCT_ID, title: 'Handmade Ceramic Mug', revenueMinor: 90000, unitsSold: 15 }],
    },
    today: { day: '2026-10-17', totals: { orders: 3, units: 4, revenueMinor: 20050 }, series: [{ minute: '2026-10-17T09:15:00.000Z', orders: 1, units: 2, revenueMinor: 9000 }] },
    rank: { period: { kind: 'week', id: '2026-W42', startsAt: '2026-10-12T00:00:00.000Z', endsAt: '2026-10-19T00:00:00.000Z', closed: false }, category: null, rank: 3, of: 120, topPercent: 3, revenueMinor: 125050 },
    errors: [],
    ...overrides,
  });
}

export function liveFrameFixture(overrides: Record<string, unknown> = {}): LiveDashboardFrame {
  return liveDashboardFrameSchema.parse({
    shopId: SELLER_SHOP_ID,
    at: 1_792_231_200,
    windowSeconds: 60,
    last60s: { checkouts: 4, orders: 2, units: 3, revenueMinor: 15000 },
    ordersPerSecond: Array.from({ length: 60 }, (_, i) => (i === 59 ? 1 : 0)),
    checkoutConversion: 0.5,
    ...overrides,
  });
}

/** Status of every code in the spec's "Error catalogue" (the status the API answers it with). */
export const SELLER_PROBLEM_STATUS = {
  validation_failed: 400,
  shop_mismatch: 400,
  invalid_topics: 400,
  invalid_query: 400,
  invalid_cursor: 400,
  unauthenticated: 401,
  invalid_token: 401,
  session_expired: 401,
  permission_denied: 403,
  insufficient_role: 403,
  mfa_required: 403,
  shop_suspended: 403,
  forbidden: 403,
  shop_not_found: 404,
  product_not_found: 404,
  member_not_found: 404,
  webhook_endpoint_not_found: 404,
  webhook_event_not_found: 404,
  resource_missing: 404,
  invite_not_found: 404,
  not_ranked: 404,
  version_conflict: 409,
  product_archived: 409,
  invalid_transition: 409,
  key_revoked: 409,
  key_expired: 409,
  key_already_rotating: 409,
  endpoint_state_conflict: 409,
  rotation_in_progress: 409,
  no_previous_secret: 409,
  endpoint_disabled: 409,
  idempotency_in_flight: 409,
  duplicate_endpoint_url: 409,
  slug_taken: 409,
  shop_limit_reached: 409,
  shop_offboarding: 409,
  seat_limit_reached: 409,
  invite_pending: 409,
  already_member: 409,
  last_owner: 409,
  stale_version: 409,
  key_limit_reached: 422,
  endpoint_limit_reached: 422,
  currency_not_supported: 422,
  version_retired: 422,
  slug_reserved: 422,
  endpoint_url_rejected: 422,
  idempotency_key_required: 422,
  idempotency_key_reuse: 422,
  rate_limited: 429,
  too_many_connections: 429,
  upstream_invalid: 502,
  upstream_unavailable: 503,
  overloaded: 503,
  service_unavailable: 503,
  serialization_failure: 503,
  cell_unavailable: 503,
  search_unavailable: 503,
  realtime_unavailable: 503,
} as const;
export type SellerProblemCode = keyof typeof SELLER_PROBLEM_STATUS;

type ProblemOptions = { status?: number; retryAfter?: number; requestId?: string; errors?: { field: string; code: string }[]; detail?: string };

/** A `application/problem+json` response for one catalogue code. `title` and `detail` are text the UI must never show. */
export function sellerProblem(code: SellerProblemCode, options: ProblemOptions = {}): Response {
  const status = options.status ?? SELLER_PROBLEM_STATUS[code];
  const body = problemDetailsSchema.parse({
    type: `https://marketplace.example/problems/${code}`,
    title: 'Server title that the UI must never show',
    status,
    detail: options.detail ?? 'Server detail that the UI must never show',
    instance: '/test',
    code,
    requestId: options.requestId ?? 'req-seller-1',
    ...(options.errors ? { errors: options.errors } : {}),
  });
  return HttpResponse.json(body, {
    status,
    headers: { 'content-type': 'application/problem+json', ...(options.retryAfter !== undefined ? { 'retry-after': String(options.retryAfter) } : {}) },
  });
}

/** Default answers for the shop reads every seller page makes; a test overrides one with `server.use(...)`. */
export const sellerHandlers = [
  http.get(`${origin}/api/shops/mine`, () => HttpResponse.json({ items: [shopListItemFixture()], nextCursor: null })),
  http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shopFixture())),
  http.get(`${origin}/api/bff/seller/${SELLER_SHOP_ID}/overview`, () => HttpResponse.json(overviewFixture())),
];
