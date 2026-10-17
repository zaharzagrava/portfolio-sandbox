import type { ReactNode } from 'react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { readLogsParams } from '@/lib/seller/search-params';
import { origin, SELLER_SHOP_ID } from '@/lib/test/seller-handlers';
import {
  useApiKeys,
  useApiVersion,
  useCreateKey,
  useCreateWebhook,
  useDeleteWebhook,
  usePingWebhook,
  useReplayEvent,
  useRequestLogs,
  useRevokeKey,
  useRotateKey,
  useRotateWebhookSecret,
  useUsage,
  useWebhookAttempts,
  useWebhookEventTypes,
  useWebhooks,
} from './seller-developers';

const ENDPOINT = '0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b';
const KEY_ID = '11111111-2222-4333-8444-555555555555';
const SECRET_KEY = 'sk_test_abcdefghijkl_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
const SECRET_HOOK = `whsec_${'A'.repeat(43)}`;
const NOW = '2026-10-17T10:00:00.000Z';
const dev = `${origin}/api/shops/${SELLER_SHOP_ID}/developers`;

const keyRow = (over: Record<string, unknown> = {}) => ({
  id: KEY_ID,
  prefix: 'abcdefghijkl',
  name: 'CI',
  scopes: ['products:read'],
  livemode: false,
  status: 'active',
  expiresAt: null,
  createdAt: NOW,
  lastUsedAt: null,
  createdBy: 'u1',
  ...over,
});
const endpoint = (over: Record<string, unknown> = {}) => ({
  id: ENDPOINT,
  url: 'https://example.com/hook',
  events: ['order.paid'],
  apiVersion: '2026-01-15',
  status: 'enabled',
  disabledReason: null,
  failingSince: null,
  breaker: 'closed',
  hasPreviousSecret: false,
  previousSecretExpiresAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, Wrapper };
}

/** Everything a cache holds, as text: the secret must not be in it (W04 AS-46). */
const cacheText = (client: QueryClient) =>
  JSON.stringify({ queries: client.getQueryCache().getAll().map((q) => [q.queryKey, q.state.data]), mutations: client.getMutationCache().getAll().map((m) => [m.state.data, m.state.variables && Object.keys(m.state.variables as object)]) });

afterEach(() => vi.restoreAllMocks());

describe('W04 secrets never reach a cache (AS-46)', () => {
  it('W04 AS-46: a created key goes to the reveal callback once and is gone from query and mutation caches', async () => {
    server.use(http.post(`${dev}/keys`, () => HttpResponse.json({ ...keyRow(), key: SECRET_KEY }, { status: 201 })));
    const { Wrapper, client } = wrapper();
    const { result } = renderHook(() => useCreateKey(SELLER_SHOP_ID), { wrapper: Wrapper });
    const reveal = vi.fn();
    const record = await result.current.mutateAsync({ body: { name: 'CI', scopes: ['products:read'], livemode: false }, reveal });
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal.mock.calls[0][0].key).toBe(SECRET_KEY);
    expect(JSON.stringify(record)).not.toContain(SECRET_KEY);
    expect(cacheText(client)).not.toContain(SECRET_KEY);
  });

  it('W04 AS-51: a rotated key reveals the new key and the old key end, and keeps the secret out of the caches', async () => {
    let body: unknown;
    server.use(http.post(`${dev}/keys/${KEY_ID}/rotate`, async ({ request }) => ((body = await request.json()), HttpResponse.json({ ...keyRow({ id: '99999999-2222-4333-8444-555555555555' }), key: SECRET_KEY, previousExpiresAt: NOW }, { status: 201 }))));
    const { Wrapper, client } = wrapper();
    const { result } = renderHook(() => useRotateKey(SELLER_SHOP_ID), { wrapper: Wrapper });
    const reveal = vi.fn();
    await result.current.mutateAsync({ keyId: KEY_ID, overlapHours: 72, reveal });
    expect(body).toEqual({ overlapHours: 72 });
    expect(reveal.mock.calls[0][0]).toMatchObject({ key: SECRET_KEY, previousExpiresAt: NOW });
    expect(cacheText(client)).not.toContain(SECRET_KEY);
  });

  it('W04 AS-57: a created endpoint reveals its whsec_ secret once and is stripped from the result', async () => {
    server.use(http.post(`${dev}/webhooks`, () => HttpResponse.json({ id: ENDPOINT, url: 'https://example.com/hook', events: ['order.paid'], apiVersion: '2026-01-15', status: 'enabled', secret: SECRET_HOOK, createdAt: NOW }, { status: 201 })));
    const { Wrapper, client } = wrapper();
    const { result } = renderHook(() => useCreateWebhook(SELLER_SHOP_ID), { wrapper: Wrapper });
    const reveal = vi.fn();
    const record = await result.current.mutateAsync({ body: { url: 'https://example.com/hook', events: ['order.paid'] }, reveal });
    expect(reveal.mock.calls[0][0].secret).toBe(SECRET_HOOK);
    expect('secret' in record).toBe(false);
    expect(cacheText(client)).not.toContain(SECRET_HOOK);
  });

  it('W04 AS-62: a rotated signing secret is revealed once; the mutation keeps only the old secret end', async () => {
    let body: unknown;
    server.use(http.post(`${dev}/webhooks/${ENDPOINT}/rotate-secret`, async ({ request }) => ((body = await request.json()), HttpResponse.json({ secret: SECRET_HOOK, previousSecretExpiresAt: NOW }, { status: 201 }))));
    const { Wrapper, client } = wrapper();
    const { result } = renderHook(() => useRotateWebhookSecret(SELLER_SHOP_ID), { wrapper: Wrapper });
    const reveal = vi.fn();
    const record = await result.current.mutateAsync({ endpointId: ENDPOINT, overlapHours: 24, reveal });
    expect(body).toEqual({ overlapHours: 24 });
    expect(record).toEqual({ previousSecretExpiresAt: NOW });
    expect(cacheText(client)).not.toContain(SECRET_HOOK);
  });
});

describe('W04 lib/api/seller-developers.ts reads', () => {
  it('W04 AS-44: the key list parses, sends limit and cursor, and the revoke is a DELETE with the CSRF header', async () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
    let seen: URL | undefined;
    let csrf: string | null = null;
    let listReads = 0;
    server.use(
      http.get(`${dev}/keys`, ({ request }) => ((seen = new URL(request.url)), (listReads += 1), HttpResponse.json({ items: [keyRow(), keyRow({ id: 'k2', status: 'rotating' })], nextCursor: null }))),
      http.delete(`${dev}/keys/${KEY_ID}`, ({ request }) => ((csrf = request.headers.get('x-csrf-token')), new HttpResponse(null, { status: 204 }))),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => ({ keys: useApiKeys(SELLER_SHOP_ID, { cursor: 'c1' }), revoke: useRevokeKey(SELLER_SHOP_ID) }), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.keys.data?.items).toHaveLength(2));
    expect(Object.fromEntries(seen!.searchParams)).toEqual({ limit: '25', cursor: 'c1' });
    await act(() => result.current.revoke.mutateAsync(KEY_ID));
    expect(csrf).toBe('tok');
    // The revoke invalidated the key list, which is on screen, so it was read again.
    await waitFor(() => expect(listReads).toBe(2));
  });

  it('W04 AS-70: request logs send the URL filters in API terms (days as UTC instants, 429 as 4xx)', async () => {
    let seen: URL | undefined;
    server.use(http.get(`${dev}/logs`, ({ request }) => ((seen = new URL(request.url)), HttpResponse.json({ items: [], nextCursor: null }))));
    const { Wrapper } = wrapper();
    const filters = readLogsParams({ requestId: 'req_1', status: '429', route: '/v1/products', livemode: 'false', from: '2026-10-01', to: '2026-10-05' });
    const { result } = renderHook(() => useRequestLogs(SELLER_SHOP_ID, filters), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(Object.fromEntries(seen!.searchParams)).toEqual({
      limit: '20',
      requestId: 'req_1',
      status: '4xx',
      route: '/v1/products',
      livemode: 'false',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-05T23:59:59.999Z',
    });
  });

  it('W04 AS-73: usage sends days and livemode; the API version state parses', async () => {
    let seen: URL | undefined;
    server.use(
      http.get(`${dev}/usage`, ({ request }) => ((seen = new URL(request.url)), HttpResponse.json({ days: [{ day: '2026-10-16', version: '2026-01-15', route: '/v1/products', calls: 3, errors: 1, deprecatedCalls: 0 }], keys: [] }))),
      http.get(`${dev}/api-version`, () => HttpResponse.json({ version: '2026-01-15', pinnedAt: null, supported: [{ version: '2026-01-15', status: 'supported' }], latest: '2026-10-01' })),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => ({ usage: useUsage(SELLER_SHOP_ID, { days: 14, livemode: false }), version: useApiVersion(SELLER_SHOP_ID) }), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.usage.data?.days).toHaveLength(1));
    await waitFor(() => expect(result.current.version.data?.latest).toBe('2026-10-01'));
    expect(Object.fromEntries(seen!.searchParams)).toEqual({ days: '14', livemode: 'false' });
  });

  it('W04 AS-58: the event catalogue keeps the API order; webhooks list and attempts send ok and cursor', async () => {
    let attempts: URL | undefined;
    server.use(
      http.get(`${dev}/webhook-event-types`, () => HttpResponse.json({ items: [{ type: 'order.paid', description: 'Paid', resource: 'order', since: '2026-01-15' }, { type: 'webhook.ping', description: 'Ping', resource: 'ping', since: '2026-01-15' }] })),
      http.get(`${dev}/webhooks`, () => HttpResponse.json({ items: [endpoint()], nextCursor: null })),
      http.get(`${dev}/webhooks/${ENDPOINT}/attempts`, ({ request }) => ((attempts = new URL(request.url)), HttpResponse.json({ items: [], nextCursor: null }))),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(
      () => ({ types: useWebhookEventTypes(SELLER_SHOP_ID), hooks: useWebhooks(SELLER_SHOP_ID), tries: useWebhookAttempts(SELLER_SHOP_ID, ENDPOINT, { ok: false, event: undefined, cursor: 'c9' }) }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.types.data?.items.map((i) => i.type)).toEqual(['order.paid', 'webhook.ping']));
    await waitFor(() => expect(result.current.hooks.data?.items).toHaveLength(1));
    await waitFor(() => expect(result.current.tries.data).toBeDefined());
    expect(Object.fromEntries(attempts!.searchParams)).toEqual({ limit: '25', ok: 'false', cursor: 'c9' });
  });
});

describe('W04 lib/api/seller-developers.ts writes', () => {
  it('W04 AS-67: replay sends the Idempotency-Key it was given, unchanged on a retry', async () => {
    const keys: (string | null)[] = [];
    server.use(
      http.post(`${dev}/webhooks/${ENDPOINT}/events/evt_1/replay`, ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        return HttpResponse.json({ deliveryId: 'd1', eventId: 'evt_1', endpointId: ENDPOINT, state: 'queued' }, { status: 202 });
      }),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useReplayEvent(SELLER_SHOP_ID, ENDPOINT), { wrapper: Wrapper });
    await act(() => result.current.mutateAsync({ eventId: 'evt_1', idempotencyKey: 'key-A' }));
    await act(() => result.current.mutateAsync({ eventId: 'evt_1', idempotencyKey: 'key-A' }));
    expect(keys).toEqual(['key-A', 'key-A']);
  });

  it('W04 AS-64: a ping returns the queued delivery and refetches the attempts of that endpoint', async () => {
    server.use(http.post(`${dev}/webhooks/${ENDPOINT}/ping`, () => HttpResponse.json({ deliveryId: 'd1', eventId: 'evt_p', endpointId: ENDPOINT, state: 'queued' }, { status: 202 })));
    const { Wrapper, client } = wrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => usePingWebhook(SELLER_SHOP_ID), { wrapper: Wrapper });
    const queued = await act(() => result.current.mutateAsync(ENDPOINT));
    expect(queued).toMatchObject({ state: 'queued' });
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
  });

  it('W04 AS-63: a deleted endpoint leaves the cached list at once and the list refetches', async () => {
    server.use(http.delete(`${dev}/webhooks/${ENDPOINT}`, () => new HttpResponse(null, { status: 204 })));
    const { Wrapper, client } = wrapper();
    client.setQueryData(queryKeys.seller.webhooks(SELLER_SHOP_ID, {}), { items: [endpoint(), endpoint({ id: 'other' })], nextCursor: null });
    const { result } = renderHook(() => useDeleteWebhook(SELLER_SHOP_ID), { wrapper: Wrapper });
    await act(() => result.current.mutateAsync(ENDPOINT));
    expect((client.getQueryData(queryKeys.seller.webhooks(SELLER_SHOP_ID, {})) as { items: { id: string }[] }).items.map((i) => i.id)).toEqual(['other']);
  });
});
