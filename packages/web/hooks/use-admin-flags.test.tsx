import type { ReactNode } from 'react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { auditPageFixture, flagFixture, flagPageFixture, FLAGS_URL, problemBody, staleFixture } from '@/lib/test/flag-fixtures';
import { useArchiveFlag, useFlag, useFlagHistory, useFlags, useKillFlag, useRestoreFlag, useSaveFlag, useStaleFlags } from './use-admin-flags';

const setup = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
};

const input = { expectedVersion: 3, owner: 'a@b.c', enabled: false, variants: [{ key: 'off', value: false }], defaultVariant: 'off', offVariant: 'off', rules: [] };

describe('use-admin-flags queries', () => {
  it('W06 AS-55: queries use the keys of lib/query-keys and are never stale', async () => {
    server.use(
      http.get(FLAGS_URL, () => HttpResponse.json(flagPageFixture())),
      http.get(`${FLAGS_URL}/new-checkout`, () => HttpResponse.json(flagFixture())),
      http.get(`${FLAGS_URL}/new-checkout/history`, () => HttpResponse.json(auditPageFixture())),
      http.get(`${FLAGS_URL}/stale`, () => HttpResponse.json(staleFixture())),
    );
    const { client, wrapper } = setup();
    const list = renderHook(() => useFlags({ status: 'killed', cursor: 'c1' }), { wrapper });
    const detail = renderHook(() => useFlag('new-checkout'), { wrapper });
    const history = renderHook(() => useFlagHistory('new-checkout', {}), { wrapper });
    const stale = renderHook(() => useStaleFlags({ days: 7 }), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess && detail.result.current.isSuccess && history.result.current.isSuccess && stale.result.current.isSuccess).toBe(true));
    expect(client.getQueryData(queryKeys.admin.flags.list({ status: 'killed', cursor: 'c1' }))).toBeDefined();
    expect(client.getQueryData(queryKeys.admin.flags.detail('new-checkout'))).toBeDefined();
    expect(client.getQueryData(queryKeys.admin.flags.history('new-checkout', {}))).toBeDefined();
    expect(client.getQueryData(queryKeys.admin.flags.stale({ days: 7 }))).toBeDefined();
    for (const key of [queryKeys.admin.flags.list({}), queryKeys.admin.flags.detail('x'), queryKeys.admin.flags.history('x', {}), queryKeys.admin.flags.stale({ days: 7 })]) {
      expect(key.slice(0, 2)).toEqual([...queryKeys.admin.flags.all]);
    }
    expect(client.getQueryCache().find({ queryKey: queryKeys.admin.flags.detail('new-checkout') })?.isStale()).toBe(true);
  });

  it('W06 FR-003: the default list key is canonical (status all, no cursor)', () => {
    expect(queryKeys.admin.flags.list({})).toEqual(queryKeys.admin.flags.list({ status: 'all', cursor: undefined }));
  });

  it('W06 AS-07: a 4xx is not retried', async () => {
    let calls = 0;
    server.use(http.get(`${FLAGS_URL}/gone-flag`, () => (calls += 1, HttpResponse.json(problemBody(404, 'flag_not_found'), { status: 404 }))));
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useFlag('gone-flag'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(calls).toBe(1);
  });

  it('W06 AS-31: initialData from the server prefetch makes the first paint have data', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useFlag('new-checkout', flagFixture()), { wrapper });
    expect(result.current.data?.key).toBe('new-checkout');
  });
});

describe('use-admin-flags mutations', () => {
  it('W06 AS-26: a save sets the detail from the response and invalidates the whole flags prefix', async () => {
    server.use(
      http.put(`${FLAGS_URL}/new-checkout`, () => HttpResponse.json(flagFixture({ version: 4, description: 'saved' }))),
      http.get(FLAGS_URL, () => HttpResponse.json(flagPageFixture())),
      http.get(`${FLAGS_URL}/new-checkout`, () => HttpResponse.json(flagFixture({ version: 4, description: 'saved' }))),
    );
    const { client, wrapper } = setup();
    renderHook(() => useFlags({}), { wrapper });
    await waitFor(() => expect(client.getQueryData(queryKeys.admin.flags.list({}))).toBeDefined());
    client.setQueryData(queryKeys.admin.flags.history('new-checkout', {}), auditPageFixture());
    const { result } = renderHook(() => useSaveFlag('new-checkout'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(input);
    });
    expect(client.getQueryData<{ version: number }>(queryKeys.admin.flags.detail('new-checkout'))?.version).toBe(4);
    expect(client.getQueryState(queryKeys.admin.flags.list({}))?.isInvalidated).toBe(false); // refetched after invalidation
    expect(client.getQueryState(queryKeys.admin.flags.history('new-checkout', {}))?.isInvalidated).toBe(true);
  });

  it.each([
    ['kill', useKillFlag],
    ['restore', useRestoreFlag],
    ['archive', useArchiveFlag],
  ] as const)('W06 AS-44: %s refetches the detail after 204 and invalidates every flags query', async (action, hook) => {
    let detailCalls = 0;
    server.use(
      http.post(`${FLAGS_URL}/new-checkout/${action}`, () => new HttpResponse(null, { status: 204 })),
      http.get(`${FLAGS_URL}/new-checkout`, () => (detailCalls += 1, HttpResponse.json(flagFixture({ status: 'killed' })))),
    );
    const { client, wrapper } = setup();
    renderHook(() => useFlag('new-checkout'), { wrapper });
    await waitFor(() => expect(detailCalls).toBe(1));
    client.setQueryData(queryKeys.admin.flags.history('new-checkout', {}), auditPageFixture());
    const { result } = renderHook(() => hook('new-checkout'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    await waitFor(() => expect(detailCalls).toBeGreaterThanOrEqual(2));
    expect(client.getQueryState(queryKeys.admin.flags.history('new-checkout', {}))?.isInvalidated).toBe(true);
  });

  it('W06 AS-39: a failed lifecycle call rejects with the response so the caller can read the problem', async () => {
    server.use(http.post(`${FLAGS_URL}/new-checkout/kill`, () => HttpResponse.json(problemBody(409, 'flag_archived'), { status: 409 })));
    const { wrapper } = setup();
    const { result } = renderHook(() => useKillFlag('new-checkout'), { wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toBeDefined();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
