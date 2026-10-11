import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { delay, http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { apiClient } from '@/lib/api/client';
import { applyQueryDefaults } from '@/lib/query-defaults';
import { problemResponse, suggestBody } from '@/lib/test/msw-handlers';
import { useSuggestions } from '@/hooks/use-suggestions';

function setup(initial: string) {
  const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } }));
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(({ text }) => useSuggestions(text), { wrapper, initialProps: { text: initial } });
}

const sleep = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

describe('useSuggestions', () => {
  it('W02 AS-07: one request per 150 ms of typing, for the last text', async () => {
    const seen: string[] = [];
    server.use(
      http.get('*/api/suggest', ({ request }) => {
        const q = new URL(request.url).searchParams.get('q') ?? '';
        seen.push(q);
        return HttpResponse.json(suggestBody(q, [`${q} case`]));
      }),
    );
    const { result, rerender } = setup('');
    for (const text of ['i', 'ip', 'iph']) {
      rerender({ text });
      await sleep(40);
    }
    expect(seen).toEqual([]);
    await waitFor(() => expect(result.current.items).toEqual(['iph case']));
    expect(seen).toEqual(['iph']);
  });

  it('W02 AS-05: asks for eight suggestions of the trimmed text', async () => {
    let url: URL | undefined;
    server.use(
      http.get('*/api/suggest', ({ request }) => {
        url = new URL(request.url);
        return HttpResponse.json(suggestBody('iph', ['iphone 17']));
      }),
    );
    const { result } = setup('  iph  ');
    await waitFor(() => expect(result.current.items).toEqual(['iphone 17']));
    expect(url?.searchParams.get('q')).toBe('iph');
    expect(url?.searchParams.get('limit')).toBe('8');
  });

  it('W02 AS-07: an answer for an older prefix that arrives late is ignored', async () => {
    server.use(
      http.get('*/api/suggest', async ({ request }) => {
        const q = new URL(request.url).searchParams.get('q') ?? '';
        if (q === 'iph') await delay(500);
        return HttpResponse.json(suggestBody(q, [`${q} result`]));
      }),
    );
    const { result, rerender } = setup('iph');
    await sleep(200); // the request for "iph" is in flight
    rerender({ text: 'ipho' });
    await waitFor(() => expect(result.current.items).toEqual(['ipho result']));
    await sleep(600); // the "iph" answer would have landed by now
    expect(result.current.items).toEqual(['ipho result']);
  });

  it('W02 AS-07: a superseded request is aborted', async () => {
    const signals = new Map<string, AbortSignal | undefined>();
    const get = apiClient.get.bind(apiClient);
    vi.spyOn(apiClient, 'get').mockImplementation((url, config) => {
      signals.set(String((config?.params as { q?: string } | undefined)?.q), config?.signal as AbortSignal | undefined);
      return get(url, config);
    });
    server.use(
      http.get('*/api/suggest', async ({ request }) => {
        const q = new URL(request.url).searchParams.get('q') ?? '';
        if (q === 'iph') await delay(1_000);
        return HttpResponse.json(suggestBody(q, [`${q} result`]));
      }),
    );
    const { result, rerender } = setup('iph');
    await sleep(250);
    expect(signals.get('iph')?.aborted).toBe(false);
    rerender({ text: 'ipho' });
    await waitFor(() => expect(result.current.items).toEqual(['ipho result']));
    expect(signals.get('iph')?.aborted).toBe(true);
    expect(signals.get('ipho')?.aborted).toBe(false);
    vi.restoreAllMocks();
  });

  it('W02 AS-07: a prefix seen in the last 60 seconds comes from the cache without a request', async () => {
    let requests = 0;
    server.use(
      http.get('*/api/suggest', ({ request }) => {
        requests += 1;
        return HttpResponse.json(suggestBody(new URL(request.url).searchParams.get('q') ?? '', ['iphone 17']));
      }),
    );
    const { result, rerender } = setup('iph');
    await waitFor(() => expect(result.current.items).toEqual(['iphone 17']));
    rerender({ text: 'x' });
    await waitFor(() => expect(requests).toBe(2));
    rerender({ text: 'IPH ' });
    await waitFor(() => expect(result.current.items).toEqual(['iphone 17']));
    await sleep(250);
    expect(requests).toBe(2);
  });

  it('W02 AS-07: no request for an empty or whitespace-only text', async () => {
    let requests = 0;
    server.use(
      http.get('*/api/suggest', () => {
        requests += 1;
        return HttpResponse.json(suggestBody('', []));
      }),
    );
    const { result, rerender } = setup('');
    rerender({ text: '   ' });
    await sleep(300);
    expect(requests).toBe(0);
    expect(result.current.items).toEqual([]);
    expect(result.current.status).toBe('idle');
  });

  it('W02 AS-07: no request for a text over 100 characters', async () => {
    let requests = 0;
    server.use(
      http.get('*/api/suggest', () => {
        requests += 1;
        return HttpResponse.json(suggestBody('', []));
      }),
    );
    setup('a'.repeat(101));
    await sleep(300);
    expect(requests).toBe(0);
  });

  it('W02 AS-05: an unknown source and unknown degraded reasons are accepted', async () => {
    server.use(
      http.get('*/api/suggest', () =>
        HttpResponse.json({ prefix: 'iph', suggestions: [{ text: 'iphone 17', source: 'future-source' }], degraded: ['new_reason'] }),
      ),
    );
    const { result } = setup('iph');
    await waitFor(() => expect(result.current.items).toEqual(['iphone 17']));
  });

  it('W02 AS-06: announces the count after the request settles, and "No suggestions" for an empty answer', async () => {
    server.use(
      http.get('*/api/suggest', ({ request }) => {
        const q = new URL(request.url).searchParams.get('q');
        return HttpResponse.json(suggestBody(q ?? '', q === 'iph' ? ['a', 'b', 'c'] : []));
      }),
    );
    const { result, rerender } = setup('iph');
    await waitFor(() => expect(result.current.announce).toBe('3 suggestions available'));
    rerender({ text: 'zzz' });
    await waitFor(() => expect(result.current.announce).toBe('No suggestions'));
    expect(result.current.status).toBe('empty');
  });

  it.each([
    ['429', () => problemResponse(429, 'rate_limited', { retryAfter: 2 })],
    ['400', () => problemResponse(400, 'validation_failed')],
    ['503', () => problemResponse(503, 'service_unavailable')],
    ['invalid body', () => HttpResponse.json({ nope: true })],
    ['network', () => HttpResponse.error()],
  ])('W02 AS-08: %s leaves the list closed with no message', async (_name, answer) => {
    server.use(http.get('*/api/suggest', answer));
    const { result } = setup('iph');
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.items).toEqual([]);
    expect(result.current.announce).toBe('');
  });

  it('W02 AS-08: the next keystroke tries again after a failure', async () => {
    let fail = true;
    server.use(
      http.get('*/api/suggest', ({ request }) =>
        fail ? problemResponse(503, 'service_unavailable') : HttpResponse.json(suggestBody(new URL(request.url).searchParams.get('q') ?? '', ['iphone 17'])),
      ),
    );
    const { result, rerender } = setup('iph');
    await waitFor(() => expect(result.current.status).toBe('error'));
    fail = false;
    rerender({ text: 'ipho' });
    await waitFor(() => expect(result.current.items).toEqual(['iphone 17']));
  });

  it('W02 AS-77: the typed text is not written to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => ({ level, spy: vi.spyOn(console, level).mockImplementation(() => {}) }));
    server.use(http.get('*/api/suggest', () => HttpResponse.error()));
    const { result } = setup('secret-text');
    await waitFor(() => expect(result.current.status).toBe('error'));
    for (const { spy } of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain('secret-text');
    spies.forEach(({ spy }) => spy.mockRestore());
  });
});
