import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SellerOverviewResponse } from '@marketplace-sandbox/contracts';
import { formatMoney } from '@/lib/utils';
import { SELLER_PRODUCT_ID, SELLER_SHOP_ID, origin, overviewFixture, sellerProblem, shopFixture } from '@/lib/test/seller-handlers';
import { server } from '../../../vitest.setup';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => `/dashboard/seller/7c1d9a2e-0b3f-4c5d-8e6f-2a3b4c5d6e7f` }));
vi.mock('./live-panel', () => ({ LivePanel: ({ shopId }: { shopId: string }) => <section aria-label="Live panel" data-shop={shopId} /> }));
// recharts measures its container; jsdom has no layout, so the chart is a placeholder here and the table is the tested output
vi.mock('recharts', () => {
  const Box = ({ children }: { children?: React.ReactNode }) => <div data-testid="chart">{children}</div>;
  return { ResponsiveContainer: Box, BarChart: Box, Bar: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null, CartesianGrid: () => null };
});

import { OverviewView } from './overview-view';

function renderView(options: { days?: number; data?: SellerOverviewResponse; serve?: SellerOverviewResponse | Response } = {}) {
  const days = options.days ?? 30;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const requests: URL[] = [];
  server.use(
    http.get(`${origin}/api/bff/seller/${SELLER_SHOP_ID}/overview`, ({ request }) => {
      requests.push(new URL(request.url));
      const serve = options.serve ?? options.data ?? overviewFixture();
      return serve instanceof Response ? serve.clone() : HttpResponse.json(serve);
    }),
  );
  const view = render(
    <QueryClientProvider client={client}>
      <OverviewView shopId={SELLER_SHOP_ID} days={days} initialData={options.data} />
    </QueryClientProvider>,
  );
  return { ...view, requests, client };
}

const region = (name: string) => screen.getByRole('region', { name });

beforeEach(() => {
  router.push.mockReset();
  router.replace.mockReset();
});

describe('W04 overview', () => {
  it('W04 AS-10: the heading is the shop name with handle, plan and role, then the sections in order', () => {
    renderView({ data: overviewFixture() });
    expect(screen.getByRole('heading', { level: 1, name: 'Clay Works' })).toBeInTheDocument();
    expect(screen.getByText(/@clay-works/)).toBeInTheDocument();
    expect(screen.getByText(/Your role: Owner/)).toBeInTheDocument();
    const order = ['Live panel', 'Today (UTC)', 'Last 30 days', 'Leaderboard rank', 'Revenue per day, last 30 days', 'Top products'];
    const nodes = order.map((name) => screen.getByRole(name === 'Live panel' ? 'region' : 'region', { name }));
    for (let i = 1; i < nodes.length; i += 1) {
      expect(nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('W04 AS-11: every amount uses the response currency and minor units; refunds and net are separate tiles', () => {
    renderView({ data: overviewFixture() });
    const tiles = region('Last 30 days');
    const tile = (label: string) => within(tiles).getByText(label).closest('[data-tile]') as HTMLElement;
    expect(tile('Revenue')).toHaveTextContent(formatMoney(125050, 'EUR'));
    expect(tile('Net revenue')).toHaveTextContent(formatMoney(122550, 'EUR'));
    expect(tile('Refunded')).toHaveTextContent(`1 · ${formatMoney(2500, 'EUR')}`);
    expect(tile('Orders')).toHaveTextContent('12');
    expect(tile('Units sold')).toHaveTextContent('20');
    expect(tile('Unique buyers')).toHaveTextContent('9');
    expect(tile('Average order value')).toHaveTextContent(formatMoney(10421, 'EUR'));
    expect(tiles).not.toHaveTextContent('$');
  });

  it('W04 AS-11: another currency is formatted from its own digits, with no default', () => {
    const base = overviewFixture();
    const data = { ...base, stats: { ...base.stats!, currency: 'JPY', summary: { ...base.stats!.summary, revenueMinor: 5000 } } };
    renderView({ data });
    expect(within(region('Last 30 days')).getByText('Revenue').closest('[data-tile]')).toHaveTextContent(formatMoney(5000, 'JPY'));
  });

  it('W04 AS-11: unique buyers above 1,000 carry a leading ≈', () => {
    const base = overviewFixture();
    renderView({ data: { ...base, stats: { ...base.stats!, summary: { ...base.stats!.summary, uniqueBuyers: 1500 } } } });
    expect(within(region('Last 30 days')).getByText('Unique buyers').closest('[data-tile]')).toHaveTextContent('≈1,500');
  });

  it('W04 AS-12: picking a period writes it to the URL; 30 is not written', async () => {
    renderView({ data: overviewFixture() });
    const select = screen.getByLabelText('Period');
    expect(select).toHaveValue('30');
    await userEvent.selectOptions(select, 'Last 7 days');
    expect(router.push).toHaveBeenLastCalledWith(`/dashboard/seller/${SELLER_SHOP_ID}?days=7`, { scroll: false });
    await userEvent.selectOptions(select, 'Last 90 days');
    expect(router.push).toHaveBeenLastCalledWith(`/dashboard/seller/${SELLER_SHOP_ID}?days=90`, { scroll: false });
  });

  it('W04 AS-12: choosing the default period drops the parameter', async () => {
    renderView({ days: 7, data: overviewFixture() });
    await userEvent.selectOptions(screen.getByLabelText('Period'), 'Last 30 days');
    expect(router.push).toHaveBeenLastCalledWith(`/dashboard/seller/${SELLER_SHOP_ID}`, { scroll: false });
  });

  it('W04 AS-12: the view asks for the period in the URL and shows it as selected', async () => {
    const { requests } = renderView({ days: 90, serve: overviewFixture() });
    expect(await screen.findByLabelText('Period')).toHaveValue('90');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get('days')).toBe('90');
  });

  it('W04 AS-13: top products show titles as plain text, in order, with units and revenue, and no link', () => {
    const base = overviewFixture();
    const data = {
      ...base,
      stats: {
        ...base.stats!,
        topProducts: [
          { productId: SELLER_PRODUCT_ID, title: 'Handmade Ceramic Mug', revenueMinor: 90000, unitsSold: 15 },
          { productId: '4f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6c', title: '<b>Bold</b> Plate', revenueMinor: 5000, unitsSold: 1 },
        ],
      },
    };
    renderView({ data });
    const top = region('Top products');
    const rows = within(top).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent(`Handmade Ceramic Mug — 15 sold — ${formatMoney(90000, 'EUR')}`);
    expect(rows[1]).toHaveTextContent(`<b>Bold</b> Plate — 1 sold — ${formatMoney(5000, 'EUR')}`);
    expect(within(top).queryByRole('link')).toBeNull();
    expect(top).not.toHaveTextContent(SELLER_PRODUCT_ID);
  });

  it('W04 AS-13: no top products says so', () => {
    const base = overviewFixture();
    renderView({ data: { ...base, stats: { ...base.stats!, topProducts: [] } } });
    expect(within(region('Top products')).getByText('No sales in this period yet.')).toBeInTheDocument();
  });

  it('W04 AS-14: the chart has a name, a best-day summary and a table alternative that is not in the URL', async () => {
    renderView({ data: overviewFixture() });
    const chart = region('Revenue per day, last 30 days');
    expect(within(chart).getByText(`Best day: Oct 17, 2026, ${formatMoney(20050, 'EUR')}`)).toBeInTheDocument();
    expect(within(chart).queryByRole('table')).toBeNull();
    await userEvent.click(within(chart).getByRole('button', { name: 'View as table' }));
    const table = within(chart).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Day', 'Revenue', 'Orders', 'Refunded']);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent(`Oct 17, 2026${formatMoney(20050, 'EUR')}3${formatMoney(2500, 'EUR')}`);
    expect(router.push).not.toHaveBeenCalled();
    await userEvent.click(within(chart).getByRole('button', { name: 'View as chart' }));
    expect(within(chart).queryByRole('table')).toBeNull();
  });

  it('W04 AS-15: a new shop shows zeros in the shop currency, no orders today, not ranked and a flat chart', () => {
    const base = overviewFixture();
    const zero = { revenueMinor: 0, orders: 0, unitsSold: 0, uniqueBuyers: 0, refundsCount: 0, refundedMinor: 0, netRevenueMinor: 0, avgOrderValueMinor: 0 };
    renderView({
      data: {
        ...base,
        stats: { ...base.stats!, summary: zero, daily: [{ day: '2026-10-17', revenueMinor: 0, orders: 0, refundedMinor: 0 }], topProducts: [] },
        today: { day: '2026-10-17', totals: { orders: 0, units: 0, revenueMinor: 0 }, series: [] },
        rank: { notRanked: true },
      },
    });
    expect(within(region('Last 30 days')).getByText('Revenue').closest('[data-tile]')).toHaveTextContent(formatMoney(0, 'EUR'));
    expect(within(region('Today (UTC)')).getByText('No orders yet today.')).toBeInTheDocument();
    expect(within(region('Leaderboard rank')).getByText('Not ranked yet. Your shop appears on the leaderboard after its first paid order.')).toBeInTheDocument();
    expect(within(region('Leaderboard rank')).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(within(region('Revenue per day, last 30 days')).getByText('No sales in this period yet.')).toBeInTheDocument();
  });

  it.each([
    [{ kind: 'week' as const, id: '2026-W42' }, null, '#3 of 120 shops · top 3 % this week'],
    [{ kind: 'month' as const, id: '2026-10' }, null, '#3 of 120 shops · top 3 % this month'],
    [{ kind: 'week' as const, id: '2026-W42' }, 'Pottery', '#3 of 120 shops in Pottery · top 3 % this week'],
  ])('W04 AS-16: the rank card reads as a sentence (%j, %s)', (period, category, sentence) => {
    const base = overviewFixture();
    const rank = base.rank as Exclude<typeof base.rank, null | { notRanked: true }>;
    renderView({ data: { ...base, rank: { ...rank, period: { ...rank.period, ...period }, category } } });
    expect(within(region('Leaderboard rank')).getByText(sentence)).toBeInTheDocument();
  });

  it('W04 AS-17: a failed stats section is replaced in the tiles, chart and top products only; the rest renders', () => {
    const data = overviewFixture({ stats: null, errors: [{ section: 'stats', code: 'upstream_unavailable', retryable: true }] });
    renderView({ data });
    for (const name of ['Last 30 days', 'Revenue per day, last 30 days', 'Top products']) {
      const section = region(name);
      expect(within(section).getByText('Sales numbers are temporarily unavailable.')).toBeInTheDocument();
      expect(within(section).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { level: 1, name: 'Clay Works' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Live panel' })).toBeInTheDocument();
    expect(within(region('Today (UTC)')).getByText('Orders')).toBeInTheDocument();
    expect(within(region('Leaderboard rank')).getByText(/#3 of 120 shops/)).toBeInTheDocument();
  });

  it.each([
    ['today', 'Today (UTC)', "Today's numbers are temporarily unavailable."],
    ['rank', 'Leaderboard rank', 'Your rank is temporarily unavailable.'],
  ] as const)('W04 AS-17: a failed %s section shows its own message and "Try again" while the others render', (section, name, text) => {
    const data = overviewFixture({ [section]: null, errors: [{ section, code: 'upstream_unavailable', retryable: true }] });
    renderView({ data });
    expect(within(region(name)).getByText(text)).toBeInTheDocument();
    expect(within(region(name)).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(within(region('Last 30 days')).getByText('Revenue')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
  });

  it('W04 AS-17: "Try again" refetches and the section is replaced by the answer; others stay', async () => {
    const failed = overviewFixture({ stats: null, errors: [{ section: 'stats', code: 'upstream_unavailable', retryable: true }] });
    const { requests } = renderView({ data: failed, serve: overviewFixture() });
    await userEvent.click(within(region('Top products')).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(region('Top products')).getByText(/Handmade Ceramic Mug/)).toBeInTheDocument());
    expect(requests).toHaveLength(1);
    expect(screen.queryByText('Sales numbers are temporarily unavailable.')).toBeNull();
  });

  it('W04 AS-18: the shop failing with 503 is a page-level state with "Try again" and nothing else', async () => {
    renderView({ serve: sellerProblem('upstream_unavailable') });
    // the hook retries a 5xx once (about 1 s) before it gives up
    expect(await screen.findByRole('button', { name: 'Try again' }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Top products' })).toBeNull();
    expect(screen.queryByText('Server title that the UI must never show')).toBeNull();
  });

  it('W04 AS-18: shop_not_found is the not-found page', async () => {
    renderView({ serve: sellerProblem('shop_not_found') });
    expect(await screen.findByText("We couldn't find that shop.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Your shops' })).toBeInTheDocument();
  });

  it('W04 AS-26: Today (UTC) shows orders, units and revenue, and the per-minute series has a text alternative', () => {
    const base = overviewFixture();
    renderView({
      data: {
        ...base,
        today: {
          day: '2026-10-17',
          totals: { orders: 3, units: 4, revenueMinor: 20050 },
          series: [
            { minute: '2026-10-17T09:15:00.000Z', orders: 1, units: 2, revenueMinor: 9000 },
            { minute: '2026-10-17T10:40:00.000Z', orders: 2, units: 2, revenueMinor: 11050 },
          ],
        },
      },
    });
    const today = region('Today (UTC)');
    expect(within(today).getByText('Orders').parentElement).toHaveTextContent('3');
    expect(within(today).getByText('Units').parentElement).toHaveTextContent('4');
    expect(within(today).getByText('Revenue').parentElement).toHaveTextContent(formatMoney(20050, 'EUR'));
    expect(within(today).getByRole('img', { name: '3 orders today, busiest minute 10:40 UTC' })).toBeInTheDocument();
  });
});

describe('W04 overview data', () => {
  it('W04 AS-11: it fetches the composed answer when it has no server data', async () => {
    const { requests } = renderView({ serve: overviewFixture({ shop: shopFixture({ name: 'Fresh Name' }) }) });
    expect(await screen.findByRole('heading', { level: 1, name: 'Fresh Name' })).toBeInTheDocument();
    expect(requests[0]!.searchParams.get('days')).toBe('30');
  });
});
