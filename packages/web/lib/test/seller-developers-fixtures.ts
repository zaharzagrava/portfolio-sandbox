import {
  apiKeyListItemSchema,
  apiVersionStateSchema,
  requestLogRowSchema,
  usageReportSchema,
  webhookAttemptSchema,
  webhookEndpointSchema,
  webhookEventDetailSchema,
  webhookEventTypesResponseSchema,
} from '@marketplace-sandbox/contracts';

/** Fixtures of the developer pages, parsed with their contract schemas so a drifting fixture fails loudly (W04 test-plan "UI unit"). */
export const KEY_ID = '11111111-2222-4333-8444-555555555555';
export const ENDPOINT_ID = '0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
export const EVENT_ID = 'evt_' + 'a1'.repeat(16);
export const NOW = '2026-10-17T10:00:00.000Z';
export const SECRET_KEY = 'sk_test_abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
export const SECRET_HOOK = 'whsec_' + 'A'.repeat(43);

export const keyFixture = (over: Record<string, unknown> = {}) =>
  apiKeyListItemSchema.parse({
    id: KEY_ID,
    prefix: 'abcdefghijkl',
    name: 'CI pipeline',
    scopes: ['products:read'],
    livemode: false,
    status: 'active',
    expiresAt: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    lastUsedAt: null,
    createdBy: 'u1',
    ...over,
  });

export const endpointFixture = (over: Record<string, unknown> = {}) =>
  webhookEndpointSchema.parse({
    id: ENDPOINT_ID,
    url: 'https://example.com/hooks/marketplace',
    events: ['order.paid'],
    apiVersion: '2026-01-15',
    status: 'enabled',
    disabledReason: null,
    failingSince: null,
    breaker: 'closed',
    hasPreviousSecret: false,
    previousSecretExpiresAt: null,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    ...over,
  });

export const eventTypesFixture = () =>
  webhookEventTypesResponseSchema.parse({
    items: [
      { type: 'order.paid', description: 'An order was paid.', resource: 'order', since: '2026-01-15' },
      { type: 'order.cancelled', description: 'An order was cancelled.', resource: 'order', since: '2026-01-15' },
      { type: 'product.updated', description: 'A product changed.', resource: 'product', since: '2026-01-15' },
    ],
  });

export const attemptFixture = (over: Record<string, unknown> = {}) =>
  webhookAttemptSchema.parse({
    attemptId: 'att-1',
    deliveryId: 'del-1',
    eventId: EVENT_ID,
    type: 'order.paid',
    attempt: 1,
    startedAt: NOW,
    durationMs: 120,
    status: 200,
    ok: true,
    replay: false,
    ...over,
  });

export const eventDetailFixture = (over: Record<string, unknown> = {}) =>
  webhookEventDetailSchema.parse({
    eventId: EVENT_ID,
    type: 'order.paid',
    createdAt: NOW,
    state: 'delivered',
    attempts: 1,
    body: { id: EVENT_ID, object: 'event', data: { object: { note: '<b>bold</b>' } } },
    ...over,
  });

export const versionFixture = (over: Record<string, unknown> = {}) =>
  apiVersionStateSchema.parse({
    version: '2026-01-15',
    pinnedAt: '2026-10-02T09:00:00.000Z',
    latest: '2026-10-01',
    supported: [
      { version: '2026-10-01', status: 'supported' },
      { version: '2026-01-15', status: 'supported' },
      { version: '2025-06-01', status: 'deprecated', sunset: '2027-01-01T00:00:00.000Z' },
    ],
    ...over,
  });

export const logRowFixture = (over: Record<string, unknown> = {}) =>
  requestLogRowSchema.parse({
    requestId: 'req_8f2a',
    clientRequestId: null,
    keyId: KEY_ID,
    livemode: false,
    version: '2026-01-15',
    method: 'GET',
    route: '/v1/products',
    status: 200,
    durationMs: 42,
    deprecated: false,
    errorCode: null,
    batchOps: 0,
    idempotentReplay: false,
    at: NOW,
    ...over,
  });

export const usageFixture = (over: Record<string, unknown> = {}) =>
  usageReportSchema.parse({
    days: [
      { day: '2026-10-16', version: '2026-01-15', route: '/v1/products', calls: 10, errors: 1, deprecatedCalls: 0 },
      { day: '2026-10-16', version: '2025-06-01', route: '/v1/orders', calls: 5, errors: 0, deprecatedCalls: 5 },
    ],
    keys: [],
    ...over,
  });
