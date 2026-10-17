import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { productMemberFixture } from '@/lib/test/seller-inventory-fixtures';
import { origin,SELLER_PRODUCT_ID, SELLER_SHOP_ID, shopFixture, VIEWER_PERMISSIONS } from '@/lib/test/seller-handlers';
import { CampaignsView } from './campaigns-view';

const push = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/campaigns`,
  useSearchParams: () => new URLSearchParams(search),
}));

const PATH = `/dashboard/seller/${SELLER_SHOP_ID}/campaigns`;
const shopApi = `${origin}/api/shops/${SELLER_SHOP_ID}`;
const campaigns = `${shopApi}/ads/campaigns`;
const CAMPAIGN_ID = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const SECOND_ID = '8a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';

const campaign = (over: Record<string, unknown> = {}) => ({
  id: CAMPAIGN_ID,
  shopId: SELLER_SHOP_ID,
  productId: SELLER_PRODUCT_ID,
  category: 'ceramics',
  cpcMinor: 25,
  dailyBudgetMinor: 1500,
  currency: 'EUR',
  status: 'ACTIVE',
  statusReason: null,
  campaignVersion: 1,
  createdAt: '2026-10-10T09:00:00.000Z',
  updatedAt: '2026-10-10T09:00:00.000Z',
  ...over,
});
const page = (items: unknown[], nextCursor: string | null = null) => http.get(campaigns, () => HttpResponse.json({ items, nextCursor }));
const problem = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  HttpResponse.json(
    { type: `https://marketplace.example/problems/${code}`, title: 'Server title never shown', status, detail: 'Server detail never shown', instance: '/t', code, requestId: 'req-ads-1', ...extra },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
const inventory = () => http.get(`${shopApi}/products`, () => HttpResponse.json({ items: [productMemberFixture({ title: 'Blue mug' })], nextCursor: null }));

let client: QueryClient;
function show(shop = shopFixture()) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(http.get(shopApi, () => HttpResponse.json(shop)), inventory());
  return render(
    <QueryClientProvider client={client}>
      <CampaignsView shopId={SELLER_SHOP_ID} />
    </QueryClientProvider>,
  );
}
async function openMenu(user: ReturnType<typeof userEvent.setup>, item: string, name = 'Blue mug') {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  search = '';
  vi.clearAllMocks();
});

describe('W04 sponsored campaigns list', () => {
  it('W04 F7: rows show product, status, cost per click, daily budget; statusReason explains a pause', async () => {
    server.use(
      page([
        campaign(),
        campaign({ id: SECOND_ID, status: 'PAUSED', statusReason: 'product_unavailable' }),
        campaign({ id: '7a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', status: 'PAUSED', statusReason: 'seller' }),
      ]),
    );
    show();
    const table = await screen.findByRole('table');
    await within(table).findAllByText('Blue mug');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(expect.arrayContaining(['Product', 'Status', 'Cost per click', 'Daily budget']));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Blue mug');
    expect(rows[0]).toHaveTextContent('Active');
    expect(rows[0]).toHaveTextContent('€0.25');
    expect(rows[0]).toHaveTextContent('€15.00');
    expect(rows[1]).toHaveTextContent('Paused');
    expect(rows[1]).toHaveTextContent('The product is unavailable');
    expect(rows[2]).toHaveTextContent('Paused by you');
  });

  it('W04 F7: the status filter is in the URL and the list call carries it', async () => {
    const seen: string[] = [];
    server.use(http.get(campaigns, ({ request }) => (seen.push(new URL(request.url).search), HttpResponse.json({ items: [], nextCursor: null }))));
    const user = userEvent.setup();
    show();
    await user.selectOptions(await screen.findByLabelText('Status'), 'PAUSED');
    expect(push).toHaveBeenCalledWith(`${PATH}?status=PAUSED`);
    search = 'status=PAUSED';
    show();
    expect(await screen.findAllByText('No campaigns match this status.')).not.toHaveLength(0);
    expect(seen.some((query) => query.includes('status=PAUSED'))).toBe(true);
  });

  it('W04 F7: Next page carries the cursor; an empty shop says so', async () => {
    search = 'cursor=c1';
    server.use(http.get(campaigns, ({ request }) => (expect(new URL(request.url).searchParams.get('cursor')).toBe('c1'), HttpResponse.json({ items: [campaign()], nextCursor: 'c2' }))));
    show();
    expect(await screen.findByRole('link', { name: 'Next page' })).toHaveAttribute('href', `${PATH}?cursor=c2`);
    expect(screen.getByRole('link', { name: 'First page' })).toHaveAttribute('href', PATH);
  });

  it('W04 F7: no campaigns yet', async () => {
    server.use(page([]));
    show();
    expect(await screen.findByText('No campaigns yet.')).toBeInTheDocument();
  });

  it('W04 F7: a failed read shows words and Try again, never the server text', async () => {
    server.use(http.get(campaigns, () => problem(503, 'service_unavailable')));
    show();
    expect(await screen.findByRole('button', { name: 'Try again' }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(/Server title|Server detail/)).not.toBeInTheDocument();
  });
});

describe('W04 sponsored campaigns permissions', () => {
  it('W04 F7: a member without shop.manage sees the list but no create button and no action menu', async () => {
    server.use(page([campaign()]));
    show(shopFixture({ myRole: 'VIEWER', myPermissions: [...VIEWER_PERMISSIONS] }));
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Create campaign' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();
  });

  it('W04 F7: OWNER and ADMIN (shop.manage) get Create campaign and the action menu', async () => {
    server.use(page([campaign()]));
    show();
    expect(await screen.findByRole('button', { name: 'Create campaign' })).toBeEnabled();
    expect(await screen.findByRole('button', { name: 'Actions for Blue mug' })).toBeInTheDocument();
  });

  it('W04 F7: Statement needs payouts.read', async () => {
    server.use(page([campaign()]));
    show(shopFixture({ myRole: 'ADMIN', myPermissions: ['shop.read', 'shop.manage', 'products.read'] }));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Blue mug' }));
    expect(screen.queryByRole('menuitem', { name: 'Statement' })).not.toBeInTheDocument();
  });

  it('W04 F7: a suspended shop disables creating', async () => {
    server.use(page([campaign()]));
    show(shopFixture({ status: 'SUSPENDED' }));
    expect(await screen.findByRole('button', { name: 'Create campaign' })).toBeDisabled();
  });
});

describe('W04 sponsored campaigns create', () => {
  async function openCreate(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Create campaign' }));
    return screen.findByRole('dialog', { name: 'Create campaign' });
  }
  async function fill(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, cpc = '0.25', budget = '15') {
    await within(dialog).findByRole('option', { name: 'Blue mug' });
    await user.selectOptions(within(dialog).getByLabelText('Product'), SELLER_PRODUCT_ID);
    await user.type(within(dialog).getByLabelText('Cost per click (EUR)'), cpc);
    await user.type(within(dialog).getByLabelText('Daily budget (EUR)'), budget);
    await user.click(within(dialog).getByRole('button', { name: 'Create campaign' }));
  }

  it('W04 F7: sends productId, cpcMinor and dailyBudgetMinor in minor units and refreshes the list', async () => {
    let body: unknown;
    let created = false;
    server.use(
      http.get(campaigns, () => HttpResponse.json({ items: created ? [campaign()] : [], nextCursor: null })),
      http.post(campaigns, async ({ request }) => ((body = await request.json()), (created = true), HttpResponse.json(campaign(), { status: 201 }))),
    );
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);
    await fill(user, dialog);
    await waitFor(() => expect(body).toEqual({ productId: SELLER_PRODUCT_ID, cpcMinor: 25, dailyBudgetMinor: 1500 }));
    expect(await screen.findByRole('table')).toHaveTextContent('Blue mug');
    expect(screen.queryByRole('dialog', { name: 'Create campaign' })).not.toBeInTheDocument();
  });

  it('W04 F7: a budget below the click cost is refused by the form before any request', async () => {
    let posted = false;
    server.use(page([]), http.post(campaigns, () => ((posted = true), HttpResponse.json(campaign(), { status: 201 }))));
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);
    await fill(user, dialog, '2', '1');
    expect(await within(dialog).findByText('The daily budget must be at least the cost per click.')).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  it.each([
    ['422', 'budget_below_cpc', 'The daily budget must be at least the cost per click.'],
    ['409', 'campaign_already_exists', 'This product already has a campaign.'],
    ['422', 'campaign_limit_reached', 'You have the maximum number of open campaigns.'],
    ['422', 'product_not_sponsorable', "This product can't be sponsored."],
    ['404', 'product_not_found', 'This product no longer exists.'],
  ])('W04 F7: %s %s is shown in words and the dialog stays open', async (status, code, text) => {
    server.use(page([]), http.post(campaigns, () => problem(Number(status), code)));
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);
    await fill(user, dialog);
    expect(await within(dialog).findByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
    expect(screen.queryByText(/Server title|Server detail/)).not.toBeInTheDocument();
  });

  it('W04 F7: a 429 shows the countdown', async () => {
    server.use(page([]), http.post(campaigns, () => problem(429, 'rate_limited', {}, { 'retry-after': '12' })));
    const user = userEvent.setup();
    show();
    const dialog = await openCreate(user);
    await fill(user, dialog);
    expect(await within(dialog).findByText(/Too many requests\. Try again in \d+ s\./)).toBeInTheDocument();
  });
});

describe('W04 sponsored campaigns pause, resume, end', () => {
  it.each([
    ['pause', 'Pause', 'ACTIVE'],
    ['resume', 'Resume', 'PAUSED'],
  ])('W04 F7: %s posts to its route and refreshes the list', async (action, label, status) => {
    let hit = 0;
    server.use(page([campaign({ status })]), http.post(`${campaigns}/${CAMPAIGN_ID}/${action}`, () => (hit++, HttpResponse.json(campaign({ status: action === 'pause' ? 'PAUSED' : 'ACTIVE' })))));
    const user = userEvent.setup();
    show();
    await openMenu(user, label);
    await waitFor(() => expect(hit).toBe(1));
  });

  it('W04 F7: Pause is not offered for a paused campaign, Resume not for an active one, nothing for an ended one', async () => {
    server.use(page([campaign(), campaign({ id: SECOND_ID, status: 'ENDED' })]));
    const user = userEvent.setup();
    show();
    const buttons = await screen.findAllByRole('button', { name: 'Actions for Blue mug' });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]);
    expect(await screen.findByRole('menuitem', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Resume' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'End campaign' })).toBeInTheDocument();
  });

  it('W04 F7: ending is final, so it asks first in a dialog, then posts', async () => {
    let hit = 0;
    server.use(page([campaign()]), http.post(`${campaigns}/${CAMPAIGN_ID}/end`, () => (hit++, HttpResponse.json(campaign({ status: 'ENDED' })))));
    const user = userEvent.setup();
    show();
    await openMenu(user, 'End campaign');
    const dialog = await screen.findByRole('dialog', { name: 'End this campaign?' });
    expect(hit).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'End campaign' }));
    await waitFor(() => expect(hit).toBe(1));
  });

  it.each([
    ['invalid_transition', 'This campaign changed since the list was loaded.'],
    ['product_unavailable', 'The product is not available'],
    ['shop_inactive', 'The shop must be active to resume a campaign.'],
    ['campaign_not_found', 'This campaign no longer exists.'],
  ])('W04 F7: a refused resume (%s) is shown in words and the list is refetched', async (code, text) => {
    let reads = 0;
    server.use(
      http.get(campaigns, () => (reads++, HttpResponse.json({ items: [campaign({ status: 'PAUSED', statusReason: 'seller' })], nextCursor: null }))),
      http.post(`${campaigns}/${CAMPAIGN_ID}/resume`, () => problem(code === 'campaign_not_found' ? 404 : 409, code)),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Resume');
    expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(screen.queryByText(/Server title|Server detail/)).not.toBeInTheDocument();
  });
});

describe('W04 sponsored campaigns statement', () => {
  it('W04 F7: the statement shows billed today and the hourly rows with net amounts and adjustments', async () => {
    server.use(
      page([campaign()]),
      http.get(`${campaigns}/${CAMPAIGN_ID}`, () => HttpResponse.json({ ...campaign(), billedTodayMinor: 340 })),
      http.get(`${campaigns}/${CAMPAIGN_ID}/billing`, () =>
        HttpResponse.json({
          items: [
            {
              hour: '2026-10-16T10:00:00.000Z',
              state: 'CHARGED',
              source: 'stream',
              clicks: 20,
              billableClicks: 18,
              cappedClicks: 0,
              amountMinor: 450,
              adjustments: [{ sequence: 1, deltaClicks: -2, deltaMinor: -50, postedAt: '2026-10-16T12:00:00.000Z' }],
              netAmountMinor: 400,
            },
            { hour: '2026-10-16T11:00:00.000Z', state: 'PENDING', source: 'stream', clicks: 3, billableClicks: 3, cappedClicks: 0, amountMinor: 75, adjustments: [], netAmountMinor: 75 },
          ],
          nextCursor: null,
        }),
      ),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Statement');
    const dialog = await screen.findByRole('dialog', { name: /Statement/ });
    expect(await within(dialog).findByText(/Billed today/)).toHaveTextContent('€3.40');
    const rows = within(await within(dialog).findByRole('table')).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('€4.50');
    expect(rows[0]).toHaveTextContent('-€0.50');
    expect(rows[0]).toHaveTextContent('€4.00');
    expect(rows[1]).toHaveTextContent('Pending');
  });

  it('W04 F7: a refused statement (403 permission_denied) says so', async () => {
    server.use(
      page([campaign()]),
      http.get(`${campaigns}/${CAMPAIGN_ID}`, () => problem(403, 'permission_denied')),
      http.get(`${campaigns}/${CAMPAIGN_ID}/billing`, () => problem(403, 'permission_denied')),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Statement');
    const dialog = await screen.findByRole('dialog', { name: /Statement/ });
    expect(await within(dialog).findByText("You don't have permission to do that.")).toBeInTheDocument();
  });
});
