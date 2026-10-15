import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { delay, http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { applyQueryDefaults } from '@/lib/query-defaults';
import { queryKeys } from '@/lib/query-keys';
import { parseSearchView } from '@/lib/search/search-view';
import { emptyResponse, PRODUCT_ID, problemResponse, searchResponse } from '@/lib/test/msw-handlers';

vi.mock('next/navigation', async () => {
  const { useEffect, useReducer } = await import('react');
  return {
    usePathname: () => '/search',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
    useSearchParams: () => {
      const [, force] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        window.addEventListener('test-nav', force);
        return () => window.removeEventListener('test-nav', force);
      }, []);
      return new URLSearchParams(window.location.search);
    },
  };
});

import { SearchResults } from '@/components/search/search-results';

const OTHER_ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a99';
const item = (id: string, title: string, position: number, overrides: Record<string, unknown> = {}) => ({
  ...searchResponse().items[0]!,
  id,
  title,
  position,
  ...overrides,
});

const realPush = window.history.pushState.bind(window.history);
const realReplace = window.history.replaceState.bind(window.history);

beforeEach(() => {
  window.history.pushState = (...args) => {
    realPush(...args);
    window.dispatchEvent(new Event('test-nav'));
  };
  window.history.replaceState = (...args) => {
    realReplace(...args);
    window.dispatchEvent(new Event('test-nav'));
  };
  realReplace(null, '', '/search');
});
afterEach(() => {
  window.history.pushState = realPush;
  window.history.replaceState = realReplace;
});

type Seed = ReturnType<typeof searchResponse>;

/** Renders the results at `address`, optionally with the server's first answer already in the cache. */
function setup(address: string, seed?: Seed, props: { adsEnabled?: boolean } = {}) {
  realReplace(null, '', address);
  const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } }));
  if (seed) client.setQueryData(queryKeys.search.results(parseSearchView(new URLSearchParams(window.location.search)).view), seed);
  render(
    <QueryClientProvider client={client}>
      <SearchResults {...props} />
    </QueryClientProvider>,
  );
  return { client, user: userEvent.setup() };
}

const answer = (handler: (url: URL) => Response | Promise<Response>) =>
  server.use(http.get('*/api/products/search', ({ request }) => handler(new URL(request.url))));

describe('SearchResults', () => {
  it('W02 AS-10: the first view comes from the cache: heading, count, cards, no skeleton, no request', async () => {
    let requests = 0;
    answer(() => {
      requests += 1;
      return HttpResponse.json(searchResponse());
    });
    setup('/search?q=espresso', searchResponse());
    expect(screen.getByRole('heading', { level: 1, name: 'Results for “espresso”' })).toBeInTheDocument();
    expect(screen.getByText('1 result')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /iPhone 17/ })).toHaveAttribute('href', `/products/${PRODUCT_ID}`);
    expect(screen.getByRole('region', { name: 'Search results' })).toHaveAttribute('aria-busy', 'false');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests).toBe(0);
  });

  describe('sponsored slot', () => {
    const ad = {
      campaignId: 'c0000000-0000-4000-8000-000000000001',
      productId: 'd0000000-0000-4000-8000-000000000001',
      shopId: 'e0000000-0000-4000-8000-000000000001',
      title: 'Promoted kettle',
      priceMinor: 4500,
      currency: 'USD',
      sponsored: true,
      clickUrl: '/api/ads/click/tok.sig',
      expiresAt: '2026-10-14T12:30:00.000Z',
    };
    let adRequests: URL[] = [];
    beforeEach(() => {
      adRequests = [];
      server.use(
        http.get('*/api/ads/sponsored', ({ request }) => {
          adRequests.push(new URL(request.url));
          return HttpResponse.json({ items: [ad], generatedAt: '2026-10-14T12:00:00.000Z' });
        }),
      );
    });

    it('W02 AS-66: with the flag on, the first page shows the slot above the results, for the selected category', async () => {
      setup('/search?category=kitchen', searchResponse(), { adsEnabled: true });
      const slot = await screen.findByRole('region', { name: 'Sponsored' });
      expect(slot).toHaveTextContent('Promoted kettle');
      expect(adRequests).toHaveLength(1);
      expect(adRequests[0]!.searchParams.get('category')).toBe('kitchen');
      const grid = screen.getByRole('link', { name: /iPhone 17/ });
      expect(slot.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('W02 AS-66: the flag is off by default: no request and no slot', async () => {
      setup('/search?q=espresso', searchResponse());
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(adRequests).toHaveLength(0);
      expect(screen.queryByRole('region', { name: 'Sponsored' })).toBeNull();
    });

    it('W02 AS-66: a later page has no slot and no request', async () => {
      setup('/search?q=espresso&cursor=abc', searchResponse(), { adsEnabled: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(adRequests).toHaveLength(0);
      expect(screen.queryByRole('region', { name: 'Sponsored' })).toBeNull();
    });
  });

  it.each([
    [{ value: 2, exact: true }, '2 results'],
    [{ value: 1, exact: true }, '1 result'],
    [{ value: 10_000, exact: false }, '10,000+ results'],
    [{ value: 1_234, exact: true }, '1,234 results'],
  ])('W02 AS-10: the count line for %j reads "%s"', (total, text) => {
    setup('/search?q=a', searchResponse({ total }));
    expect(screen.getByText(text, { selector: '[role="status"]' })).toBeInTheDocument();
  });

  it('W02 AS-20: without q the page is in browse mode: heading "All products" and no meaning switch', () => {
    setup('/search', searchResponse());
    expect(screen.getByRole('heading', { level: 1, name: 'All products' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Match by meaning' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveDisplayValue('Featured');
  });

  it('W02 AS-27: one h1, a Filters form, and the Search results region contains the count', () => {
    setup('/search?q=a', searchResponse());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('form', { name: 'Filters' })).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'Search results' });
    expect(within(region).getByText('1 result')).toBeInTheDocument();
    expect(screen.queryByRole('main')).toBeNull();
  });

  it('W02 AS-18: the same item twice on a page is shown once', () => {
    const first = item(PRODUCT_ID, 'Same', 0);
    setup('/search?q=a', searchResponse({ items: [first, { ...first, position: 1 }, item(OTHER_ID, 'Other', 2)] }));
    expect(screen.getAllByRole('link', { name: /Same/ })).toHaveLength(1);
    expect(screen.getAllByTestId('product-card')).toHaveLength(2);
  });

  it('W02 AS-22: a sponsored item keeps its position and carries the label', () => {
    setup('/search?q=a', searchResponse({ items: [item(PRODUCT_ID, 'First', 0), item(OTHER_ID, 'Ad item', 1, { sponsored: true })] }));
    const cards = screen.getAllByTestId('product-card');
    expect(cards[1]).toHaveTextContent('Sponsored');
    expect(cards[1]).toHaveTextContent('Ad item');
  });

  it('W02 AS-18: Next page keeps every parameter and sets the cursor; the page moves without a reload and focus goes to the heading', async () => {
    const { user } = setup('/search?q=espresso&category=coffee&sort=newest', searchResponse({ nextCursor: 'tok-2' }));
    answer(() => HttpResponse.json(searchResponse({ nextCursor: null })));
    const next = screen.getByRole('link', { name: 'Next page' });
    expect(next).toHaveAttribute('href', '/search?q=espresso&category=coffee&sort=newest&cursor=tok-2');
    expect(screen.queryByRole('link', { name: 'Back to first page' })).toBeNull();
    await user.click(next);
    expect(window.location.search).toBe('?q=espresso&category=coffee&sort=newest&cursor=tok-2');
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    expect(await screen.findByRole('link', { name: 'Back to first page' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Next page' })).toBeNull();
  });

  it('W02 AS-18: Back to first page removes the cursor', async () => {
    const { user } = setup('/search?q=espresso&cursor=tok-2', searchResponse({ nextCursor: null }));
    await user.click(screen.getByRole('link', { name: 'Back to first page' }));
    expect(window.location.search).toBe('?q=espresso');
  });

  it('W02 AS-11: any change but the page drops the cursor', async () => {
    const { user } = setup('/search?q=espresso&cursor=tok-2', searchResponse({ nextCursor: null }));
    answer(() => HttpResponse.json(searchResponse()));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'price-desc');
    expect(window.location.search).toBe('?q=espresso&sort=price-desc');
  });

  it('W02 AS-18: the count line is the same on every page', () => {
    const total = { value: 57, exact: true };
    setup('/search?q=a&cursor=tok-3', searchResponse({ total, nextCursor: 'tok-4' }));
    expect(screen.getByText('57 results', { selector: '[role="status"]' })).toBeInTheDocument();
    expect(screen.queryByText(/page \d/i)).toBeNull();
  });

  it('W02 AS-19: no match shows the message, the hint with q, and Clear all filters only when filters are on', async () => {
    const { user } = setup('/search?q=zzz&category=coffee&sort=newest', searchResponse({ items: [], total: { value: 0, exact: true } }));
    expect(screen.getByText('No products match your search.')).toBeInTheDocument();
    expect(screen.getByText('Try a different spelling or fewer words.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove filter Category: coffee' })).toBeInTheDocument();
    answer(() => HttpResponse.json(searchResponse({ items: [], total: { value: 0, exact: true } })));
    await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(window.location.search).toBe('?q=zzz&sort=newest');
    expect(screen.queryByRole('button', { name: 'Clear all filters' })).toBeNull();
  });

  it('W02 AS-19: an empty browse has no spelling hint', () => {
    setup('/search', searchResponse({ items: [], total: { value: 0, exact: true } }));
    expect(screen.getByText('No products match your search.')).toBeInTheDocument();
    expect(screen.queryByText(/different spelling/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('W02 AS-15: removing a chip updates the address and returns focus to the heading', async () => {
    const { user } = setup('/search?q=a&category=coffee&minRating=4', searchResponse());
    answer(() => HttpResponse.json(searchResponse()));
    await user.click(screen.getByRole('button', { name: 'Remove filter Category: coffee' }));
    expect(window.location.search).toBe('?q=a&minRating=4');
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });

  it('W02 AS-27: a filter change does not move focus', async () => {
    const { user } = setup('/search?q=a', searchResponse());
    answer(() => HttpResponse.json(searchResponse()));
    const toggle = screen.getByRole('switch', { name: 'In stock only' });
    await user.click(toggle);
    expect(window.location.search).toBe('?q=a&inStock=true');
    expect(toggle).toHaveFocus();
  });

  it('W02 AS-21: Match by meaning sets semantic=true; the closest matches line replaces paging; facet counts are hidden', async () => {
    const { user } = setup('/search?q=warm+coat', searchResponse({ nextCursor: 'tok-2' }));
    answer(() => HttpResponse.json(searchResponse({ mode: 'semantic', nextCursor: 'tok-2', facets: undefined })));
    await user.click(screen.getByRole('switch', { name: 'Match by meaning' }));
    expect(window.location.search).toBe('?q=warm+coat&semantic=true');
    expect(await screen.findByText('Showing the closest matches')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Next page' })).toBeNull();
    expect(screen.getByText("Counts aren't available for meaning search.")).toBeInTheDocument();
  });

  it('W02 AS-21: a degraded meaning search shows the notice and keeps the switch on', () => {
    setup('/search?q=a&semantic=true', searchResponse({ mode: 'lexical', degraded: ['semantic_unavailable'] }));
    expect(screen.getByText('Meaning search is unavailable right now. Showing keyword results.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Match by meaning' })).toBeChecked();
  });

  it('W02 AS-24: invalid_cursor restarts from the first page with a notice', async () => {
    answer(() => problemResponse(422, 'invalid_cursor'));
    setup('/search?q=a&cursor=old');
    await waitFor(() => expect(window.location.search).toBe('?q=a'));
    expect(await screen.findByText('That page is no longer available. Showing the first page.')).toBeInTheDocument();
  });

  it.each([
    ['invalid_price_range', '/search?q=a&minPriceMinor=100&maxPriceMinor=200', '?q=a'],
    ['semantic_requires_query', '/search?semantic=true&q=a', '?q=a'],
    ['unsupported_combination', '/search?q=a&semantic=true&category=x', '?q=a&category=x'],
  ])('W02 AS-24: %s falls back to the cleaned view without an alert', async (code, address, expected) => {
    answer(() => problemResponse(422, code));
    setup(address);
    await waitFor(() => expect(window.location.search).toBe(expected));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('W02 AS-24: 429 shows the wait and keeps Try again disabled until it has passed', async () => {
    answer(() => problemResponse(429, 'rate_limited', { retryAfter: 1 }));
    setup('/search?q=a');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many searches. Try again in 1 second.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled(), { timeout: 2_500 });
  });

  it.each([
    ['503', () => problemResponse(503, 'search_unavailable', { requestId: 'req-503' })],
    ['500', () => problemResponse(500, 'internal_error', { requestId: 'req-500' })],
    ['no body', () => emptyResponse(502)],
  ])('W02 AS-24: %s shows one alert with Try again, and the reference when the body has one', async (name, response) => {
    answer(response);
    setup('/search?q=a');
    const alert = await screen.findByRole('alert');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(alert).toHaveTextContent('Search is temporarily unavailable. Try again.');
    if (name !== 'no body') expect(alert).toHaveTextContent(`Reference: req-${name}`);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(screen.queryByTestId('search-results')).toBeNull();
    expect(screen.queryByText('No products match your search.')).toBeNull();
    // The box and filters stay usable.
    expect(screen.getByRole('form', { name: 'Filters' })).toBeInTheDocument();
  });

  it('W02 AS-24: Try again asks again and shows the results when the service is back', async () => {
    let healthy = false;
    answer(() => (healthy ? HttpResponse.json(searchResponse()) : problemResponse(503, 'search_unavailable')));
    const { user } = setup('/search?q=a');
    await screen.findByRole('alert');
    healthy = true;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /iPhone 17/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('W02 AS-24: offline shows the offline copy with Reconnecting… and retries when the browser comes back online', async () => {
    let online = false;
    answer(() => (online ? HttpResponse.json(searchResponse()) : HttpResponse.error()));
    setup('/search?q=a');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You appear to be offline. Check your connection and try again.');
    expect(screen.getByText('Reconnecting…')).toHaveAttribute('aria-busy', 'true');
    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(await screen.findByRole('link', { name: /iPhone 17/ })).toBeInTheDocument();
  });

  it('W02 AS-25: a client change keeps the previous results dimmed and busy until the new ones arrive', async () => {
    const { user } = setup('/search?q=a', searchResponse({ items: [item(PRODUCT_ID, 'Old result', 0)] }));
    answer(async () => {
      await delay(300);
      return HttpResponse.json(searchResponse({ items: [item(OTHER_ID, 'New result', 0)] }));
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'newest');
    const region = screen.getByRole('region', { name: 'Search results' });
    await waitFor(() => expect(region).toHaveAttribute('aria-busy', 'true'));
    expect(screen.getByRole('link', { name: /Old result/ })).toBeInTheDocument();
    expect(screen.queryByTestId('search-skeleton')).toBeNull();
    expect(await screen.findByRole('link', { name: /New result/ })).toBeInTheDocument();
    expect(region).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByRole('link', { name: /Old result/ })).toBeNull();
  });

  it('W02 AS-25: a view visited within the stale time shows from the cache without a request', async () => {
    const { user } = setup('/search?q=a&sort=newest', searchResponse({ items: [item(PRODUCT_ID, 'Newest first', 0)] }));
    let requests = 0;
    answer(() => {
      requests += 1;
      return HttpResponse.json(searchResponse({ items: [item(OTHER_ID, 'Other order', 0)] }));
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), '');
    await screen.findByRole('link', { name: /Other order/ });
    expect(requests).toBe(1);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), 'newest');
    expect(screen.getByRole('link', { name: /Newest first/ })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requests).toBe(1);
  });

  it('W02 AS-23: opening a result sends one click record with the API position and the searchId', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    server.use(http.post('*/api/search/clicks', () => new HttpResponse(null, { status: 204 })));
    const { user } = setup('/search?q=a', searchResponse({ searchId: 'sid-7', items: [item(PRODUCT_ID, 'Result', 4)] }));
    const link = screen.getByRole('link', { name: /Result/ });
    link.addEventListener('click', (event) => event.preventDefault());
    await user.click(link);
    await waitFor(() => expect(fetchSpy.mock.calls.some(([url]) => String(url).endsWith('/api/search/clicks'))).toBe(true));
    const call = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/api/search/clicks'))!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ searchId: 'sid-7', productId: PRODUCT_ID, position: 4 });
    fetchSpy.mockRestore();
  });

  it('W02 AS-26: the Filters button on small screens opens the same panel as a sheet with its footer actions', async () => {
    const { user } = setup('/search?q=a&category=coffee', searchResponse({ total: { value: 12, exact: true } }));
    await user.click(screen.getByRole('button', { name: /^Filters/ }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('form', { name: 'Filters' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Show 12 results' })).toBeInTheDocument();
    answer(() => HttpResponse.json(searchResponse()));
    await user.click(within(sheet).getByRole('button', { name: 'Clear all' }));
    expect(window.location.search).toBe('?q=a');
  });
});
