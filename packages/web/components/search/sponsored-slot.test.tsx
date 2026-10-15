import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { problemResponse } from '@/lib/test/msw-handlers';
import { SponsoredSlot } from '@/components/search/sponsored-slot';

const slot = (n: number, overrides: Record<string, unknown> = {}) => ({
  campaignId: `c0000000-0000-4000-8000-00000000000${n}`,
  productId: `d0000000-0000-4000-8000-00000000000${n}`,
  shopId: `e0000000-0000-4000-8000-00000000000${n}`,
  title: `Sponsored thing ${n}`,
  priceMinor: 1999 * n,
  currency: 'USD',
  sponsored: true,
  clickUrl: `/api/ads/click/token-${n}.sig`,
  expiresAt: '2026-10-14T12:30:00.000Z',
  ...overrides,
});
const body = (items: unknown[]) => ({ items, generatedAt: '2026-10-14T12:00:00.000Z' });

let requests: Request[] = [];
const serve = (handler: () => Response | Promise<Response>) =>
  server.use(
    http.get('*/api/ads/sponsored', ({ request }) => {
      requests.push(request);
      return handler();
    }),
  );

function show(props: { enabled?: boolean; category?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
  return render(
    <QueryClientProvider client={client}>
      <SponsoredSlot enabled={props.enabled ?? true} category={props.category} />
    </QueryClientProvider>,
  );
}

const settled = async () => {
  await waitFor(() => expect(requests.length).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 50));
};

beforeEach(() => {
  requests = [];
  document.cookie = 'anonymous_id=; Max-Age=0; Path=/';
  Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: undefined });
  Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: null });
});

describe('SponsoredSlot', () => {
  it('W02 AS-66: up to three cards labelled Sponsored, each with title and price', async () => {
    serve(() => HttpResponse.json(body([slot(1), slot(2), slot(3)])));
    show();
    const region = await screen.findByRole('region', { name: 'Sponsored' });
    const cards = screen.getAllByRole('link');
    expect(cards).toHaveLength(3);
    expect(region).toHaveTextContent('Sponsored thing 1');
    expect(cards[0]).toHaveTextContent('Sponsored');
    expect(cards[0]).toHaveTextContent('$19.99');
  });

  it('W02 AS-66: clickUrl is used verbatim with rel "sponsored nofollow", and it is a plain link that is not prefetched', async () => {
    serve(() => HttpResponse.json(body([slot(1), slot(2, { clickUrl: 'https://ads.example/c/abc?x=1&y=2#frag' })])));
    show();
    const links = await screen.findAllByRole('link');
    expect(links[0]).toHaveAttribute('href', '/api/ads/click/token-1.sig');
    expect(links[1]).toHaveAttribute('href', 'https://ads.example/c/abc?x=1&y=2#frag');
    for (const link of links) {
      expect(link.getAttribute('rel')?.split(' ').sort()).toEqual(['nofollow', 'sponsored']);
      expect(link).not.toHaveAttribute('data-prefetch');
    }
    expect(document.querySelector('link[rel="prefetch"], link[rel="preload"]')).toBeNull();
  });

  it('W02 AS-66: one request with limit=3, the category, no caching and the anonymous id', async () => {
    serve(() => HttpResponse.json(body([slot(1)])));
    show({ category: 'kitchen' });
    await screen.findByRole('region', { name: 'Sponsored' });
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe('/api/ads/sponsored');
    expect(url.searchParams.get('limit')).toBe('3');
    expect(url.searchParams.get('category')).toBe('kitchen');
    expect(requests[0]!.headers.get('cache-control')).toBe('no-store');
    expect(requests[0]!.headers.get('x-anonymous-id')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(requests[0]!.headers.get('x-anonymous-id')).toBe(document.cookie.match(/anonymous_id=([^;]+)/)?.[1]);
  });

  it('W02 AS-66: without a category no category is sent, and an unusable category is not sent either', async () => {
    serve(() => HttpResponse.json(body([slot(1)])));
    const first = show();
    await screen.findByRole('region', { name: 'Sponsored' });
    expect(new URL(requests[0]!.url).searchParams.has('category')).toBe(false);
    first.unmount();
    requests = [];
    show({ category: 'Home & Garden' });
    await screen.findByRole('region', { name: 'Sponsored' });
    expect(new URL(requests[0]!.url).searchParams.has('category')).toBe(false);
  });

  it('W02 AS-66: under Global Privacy Control the request carries no anonymous id and no cookie is created', async () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: true });
    serve(() => HttpResponse.json(body([slot(1)])));
    show();
    await screen.findByRole('region', { name: 'Sponsored' });
    expect(requests[0]!.headers.has('x-anonymous-id')).toBe(false);
    expect(document.cookie).not.toContain('anonymous_id');
  });

  it.each([
    ['empty items', () => HttpResponse.json(body([]))],
    ['429', () => problemResponse(429, 'rate_limited', { retryAfter: 30 })],
    ['503', () => problemResponse(503, 'service_unavailable')],
    ['an invalid body', () => HttpResponse.json({ items: 'x' })],
    ['a non-JSON body', () => new HttpResponse('<html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['no network', () => HttpResponse.error()],
  ])('W02 AS-66: %s renders nothing and no message', async (_name, handler) => {
    serve(handler);
    const view = show();
    await settled();
    expect(view.container).toBeEmptyDOMElement();
  });

  it('W02 AS-66: an answer with more than three items is invalid and renders nothing', async () => {
    serve(() => HttpResponse.json(body([slot(1), slot(2), slot(3), slot(4)])));
    const view = show();
    await settled();
    expect(view.container).toBeEmptyDOMElement();
  });

  it('W02 AS-66: with the flag off no request is made and nothing is rendered', async () => {
    serve(() => HttpResponse.json(body([slot(1)])));
    const view = show({ enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests).toHaveLength(0);
    expect(view.container).toBeEmptyDOMElement();
  });

  it('W02 AS-72: a non-https or protocol-relative clickUrl is ignored: that item is not shown, the others are', async () => {
    serve(() =>
      HttpResponse.json(
        body([
          slot(1, { clickUrl: 'http://ads.example/c/1' }),
          slot(2, { clickUrl: 'javascript:alert(1)' }),
          slot(3, { clickUrl: '//evil.example/c' }),
        ]),
      ),
    );
    const view = show();
    await settled();
    expect(view.container).toBeEmptyDOMElement();

    server.resetHandlers();
    requests = [];
    serve(() => HttpResponse.json(body([slot(1, { clickUrl: 'http://ads.example/c/1' }), slot(2)])));
    view.unmount();
    show();
    const links = await screen.findAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/api/ads/click/token-2.sig');
  });

  it('W02 AS-72: titles are text, never markup', async () => {
    serve(() => HttpResponse.json(body([slot(1, { title: '<img src=x onerror=alert(1)>' })])));
    show();
    expect(await screen.findByRole('link')).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});
