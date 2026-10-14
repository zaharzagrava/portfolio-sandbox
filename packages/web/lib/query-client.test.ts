import { QueryObserver, onlineManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { getQueryClient, makeQueryClient, shouldRetryQuery } from './query-client';

const failure = (status?: number) => (status === undefined ? new Error('Network Error') : { response: { status } });

describe('W07 query client defaults (AS-36)', () => {
  it.each([
    ['network error', undefined, 0, true],
    ['network error, second failure', undefined, 1, true],
    ['network error, third failure', undefined, 2, false],
    ['500', 500, 0, true],
    ['502', 502, 1, true],
    ['503', 503, 2, false],
    ['400', 400, 0, false],
    ['401', 401, 0, false],
    ['403', 403, 0, false],
    ['404', 404, 0, false],
    ['409', 409, 0, false],
    ['422', 422, 0, false],
  ])('W07 AS-36: retry decision for %s (failure %i)', (_label, status, failureCount, expected) => {
    expect(shouldRetryQuery(failureCount, failure(status))).toBe(expected);
  });

  it('W07 AS-36: an error that marks itself retryable: false is never retried', () => {
    expect(shouldRetryQuery(0, Object.assign(new Error('invalid body'), { retryable: false }))).toBe(false);
  });

  it('W07 AS-36: stale time 60 s, no refetch on focus, refetch on reconnect, mutations never retry', () => {
    const options = makeQueryClient().getDefaultOptions();
    expect(options.queries?.staleTime).toBe(60_000);
    expect(options.queries?.refetchOnWindowFocus).toBe(false);
    expect(options.queries?.refetchOnReconnect).toBe(true);
    expect(options.mutations?.retry).toBe(false);
  });

  it('W07 AS-36: backoff is exponential and capped', () => {
    const delay = makeQueryClient().getDefaultOptions().queries?.retryDelay as (attempt: number) => number;
    expect(delay(0)).toBe(1000);
    expect(delay(1)).toBe(2000);
    expect(delay(9)).toBeLessThanOrEqual(30_000);
  });

  it('W07 AS-36: one client per tab in the browser, a new one per request on the server', () => {
    expect(getQueryClient(false)).toBe(getQueryClient(false));
    expect(getQueryClient(true)).not.toBe(getQueryClient(true));
    expect(getQueryClient(true)).not.toBe(getQueryClient(false));
  });

  describe('reconnect (AS-14, FR-065)', () => {
    afterEach(() => onlineManager.setOnline(true));

    it('W07 AS-14: a query that failed is fetched again, once, when the connection returns', async () => {
      const client = makeQueryClient();
      client.mount();
      let calls = 0;
      const observer = new QueryObserver(client, {
        queryKey: ['products', 'reconnect-test'],
        queryFn: async () => {
          calls += 1;
          if (calls === 1) throw failure(404);
          return 'ok';
        },
      });
      const unsubscribe = observer.subscribe(() => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toBe(1);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(calls).toBe(2);
      expect(observer.getCurrentResult().data).toBe('ok');
      unsubscribe();
      client.unmount();
    });
  });
});
