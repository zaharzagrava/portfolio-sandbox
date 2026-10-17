import { http, HttpResponse } from 'msw';
import {
  conflictPageSchema,
  integrationPageSchema,
  integrationSchema,
  quarantineItemSchema,
  quarantinePageSchema,
  reconciliationReportSchema,
  reconciliationSummarySchema,
  stockConflictSchema,
  syncConflictSchema,
} from '@marketplace-sandbox/contracts';
import { origin, SELLER_SHOP_ID } from './seller-handlers';

/** F3 fixtures (S08, S09): every body is parsed with its contract schema when it is built, so a drifting fixture fails here. */

export const INTEGRATION_ID = '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
export const QUARANTINE_ID = '9b2c3d4e-5f6a-4b7c-8d8e-0f1a2b3c4d5e';
export const CONFLICT_ID = 'ac3d4e5f-6a7b-4c8d-9e9f-1a2b3c4d5e6f';
export const RUN_ID = 'bd4e5f6a-7b8c-4d9e-8fa0-2b3c4d5e6f70';
export const PREVIOUS_RUN_ID = 'ce5f6a7b-8c9d-4eaf-9ab1-3c4d5e6f7081';
export const PRODUCT_ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';

export const integrations = `${origin}/api/shops/${SELLER_SHOP_ID}/integrations`;
export const integrationUrl = `${integrations}/${INTEGRATION_ID}`;

export function integrationFixture(overrides: Record<string, unknown> = {}) {
  return integrationSchema.parse({
    id: INTEGRATION_ID,
    provider: 'shopify',
    externalShop: 'clay-works.myshopify.com',
    status: 'ACTIVE',
    pausedReason: null,
    lastError: null,
    lastSyncAt: '2026-10-17T09:00:00.000Z',
    watermark: '2026-10-17T08:59:00.000Z',
    lagSeconds: 120,
    linkedProducts: 42,
    openQuarantine: 2,
    openConflicts: 1,
    breakerOpenUntil: null,
    credentialsSet: true,
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  });
}

export const integrationPage = (items = [integrationFixture()], nextCursor: string | null = null) => integrationPageSchema.parse({ items, nextCursor });

export function quarantineFixture(overrides: Record<string, unknown> = {}) {
  return quarantineItemSchema.parse({
    id: QUARANTINE_ID,
    integrationId: INTEGRATION_ID,
    entity: 'product',
    externalId: 'gid://shopify/Product/1001',
    reasonCode: 'missing_price',
    message: 'The product has no price.',
    payload: { title: 'Mug' },
    status: 'OPEN',
    occurrences: 3,
    firstSeenAt: '2026-10-15T09:00:00.000Z',
    lastSeenAt: '2026-10-17T08:00:00.000Z',
    resolution: null,
    resolvedAt: null,
    ...overrides,
  });
}
export const quarantinePage = (items = [quarantineFixture()], nextCursor: string | null = null) => quarantinePageSchema.parse({ items, nextCursor });

export function stockConflictFixture(overrides: Record<string, unknown> = {}) {
  return stockConflictSchema.parse({
    id: CONFLICT_ID,
    integrationId: INTEGRATION_ID,
    externalId: 'gid://shopify/Product/1001',
    productId: PRODUCT_ID,
    kind: 'oversold',
    base: 10,
    local: 6,
    remote: 7,
    merged: 3,
    resolvedTo: 3,
    status: 'OPEN',
    createdAt: '2026-10-16T09:00:00.000Z',
    dismissedAt: null,
    ...overrides,
  });
}
export const conflictPage = (items = [stockConflictFixture()], nextCursor: string | null = null) => conflictPageSchema.parse({ items, nextCursor });

export function reconciliationSummaryFixture(overrides: Record<string, unknown> = {}) {
  return reconciliationSummarySchema.parse({
    id: RUN_ID,
    integrationId: INTEGRATION_ID,
    startedAt: '2026-10-17T03:00:00.000Z',
    finishedAt: '2026-10-17T03:02:00.000Z',
    outcome: 'completed',
    counts: { matched: 40, missing_at_provider: 1, content_drift: 1 },
    ...overrides,
  });
}
export function reconciliationReportFixture(overrides: Record<string, unknown> = {}) {
  return reconciliationReportSchema.parse({
    ...reconciliationSummaryFixture(),
    findings: [
      { kind: 'missing_at_provider', externalId: 'gid://shopify/Product/2002', detail: 'Deleted in the store' },
      { kind: 'content_drift', externalId: 'gid://shopify/Product/3003', previousRunId: PREVIOUS_RUN_ID, outcome: 'fixed' },
      { kind: 'stock_drift', externalId: 'gid://shopify/Product/4004', previousRunId: PREVIOUS_RUN_ID, outcome: 'still_open' },
    ],
    truncated: false,
    previousRunId: PREVIOUS_RUN_ID,
    ...overrides,
  });
}

export function offlineConflictFixture(overrides: Record<string, unknown> = {}) {
  return syncConflictSchema.parse({
    opId: '01927b3e-7a52-7c1d-9a3b-0123456789ab',
    deviceId: 'pos-device-1',
    productId: PRODUCT_ID,
    kind: 'oversold',
    requested: -5,
    applied: -3,
    shortfall: 2,
    quantityAfter: 0,
    status: 'open',
    createdAt: '2026-10-17T07:00:00.000Z',
    ...overrides,
  });
}

/** A problem+json answer with the stable `code`; its `detail` is a text the UI must never show. */
export function problemResponse(status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return HttpResponse.json(
    { type: 'about:blank', title: 'Never shown', status, detail: 'Never shown detail', instance: '/x', code, requestId: 'req-int-1', ...extra },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
}

export const listHandler = (items = [integrationFixture()]) => http.get(integrations, () => HttpResponse.json(integrationPage(items)));
