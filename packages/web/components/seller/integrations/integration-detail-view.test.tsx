import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import {
  CONFLICT_ID,
  conflictPage,
  INTEGRATION_ID,
  integrationFixture,
  integrationUrl,
  PREVIOUS_RUN_ID,
  problemResponse,
  QUARANTINE_ID,
  quarantineFixture,
  quarantinePage,
  reconciliationReportFixture,
  reconciliationSummaryFixture,
  RUN_ID,
  stockConflictFixture,
} from '@/lib/test/seller-integrations-fixtures';
import { origin, SELLER_SHOP_ID, shopFixture, VIEWER_PERMISSIONS } from '@/lib/test/seller-handlers';
import { IntegrationDetailView } from './integration-detail-view';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const push = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/integrations/${INTEGRATION_ID}`,
  useSearchParams: () => new URLSearchParams(search),
}));

/**
 * W04 F3 (S08): one integration's status, its actions (`sync`, `reconcile`, pause, resume, disconnect) and its quarantine,
 * stock conflicts and reconciliations, all through the HTTP routes.
 */

const listUrl = `/dashboard/seller/${SELLER_SHOP_ID}/integrations`;
let client: QueryClient;
function show(shop = shopFixture(), id = INTEGRATION_ID) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shop)));
  return render(
    <QueryClientProvider client={client}>
      <IntegrationDetailView shopId={SELLER_SHOP_ID} integrationId={id} />
    </QueryClientProvider>,
  );
}
const status = (overrides: Record<string, unknown> = {}) => http.get(integrationUrl, () => HttpResponse.json(integrationFixture(overrides)));
const emptyQuarantine = http.get(`${integrationUrl}/quarantine`, () => HttpResponse.json(quarantinePage([])));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  search = '';
  vi.clearAllMocks();
});

describe('W04 F3 integration status', () => {
  it('W04 F3-20: shows the store, provider, status, last sync, lag, linked products and open counts', async () => {
    server.use(status({ lastError: 'Provider said 500' }), emptyQuarantine);
    show();
    expect(await screen.findByRole('heading', { level: 1, name: 'clay-works.myshopify.com' })).toBeInTheDocument();
    const facts = screen.getByRole('region', { name: 'Status' });
    expect(facts).toHaveTextContent('Shopify');
    expect(facts).toHaveTextContent('Active');
    expect(facts).toHaveTextContent('2 min behind');
    expect(facts).toHaveTextContent('42');
    expect(facts).toHaveTextContent('Last error: Provider said 500');
    expect(screen.getByRole('link', { name: 'Quarantine (2)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Stock conflicts (1)' })).toBeInTheDocument();
  });

  it('W04 F3-21: an open circuit breaker says when syncing resumes', async () => {
    server.use(status({ breakerOpenUntil: '2026-10-17T12:00:00.000Z' }), emptyQuarantine);
    show();
    expect(await screen.findByText(/Syncing is paused after repeated errors until /)).toBeInTheDocument();
  });

  it('W04 F3-22: 404 integration_not_found and 400 invalid_uuid are told apart and never show the API detail', async () => {
    server.use(http.get(integrationUrl, () => problemResponse(404, 'integration_not_found')));
    const first = show();
    expect(await screen.findByText('This integration was disconnected or does not exist.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to integrations' })).toHaveAttribute('href', listUrl);
    expect(screen.queryByText('Never shown detail')).not.toBeInTheDocument();
    first.unmount();
    client.clear();
    server.use(http.get(integrationUrl, () => problemResponse(400, 'invalid_uuid')));
    show();
    expect(await screen.findByText("This link isn't valid.")).toBeInTheDocument();
  });

  it('W04 F3-23: a member without integrations.manage sees the status and no action', async () => {
    server.use(status(), emptyQuarantine);
    show(shopFixture({ myRole: 'VIEWER', myPermissions: [...VIEWER_PERMISSIONS] }));
    await screen.findByRole('heading', { level: 1, name: 'clay-works.myshopify.com' });
    for (const name of ['Sync now', 'Full resync', 'Reconcile', 'Pause', 'Disconnect']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });
});

describe('W04 F3 integration actions', () => {
  it('W04 F3-24: "Sync now" posts mode incremental and says it started; breaker_open and an already queued sync read differently', async () => {
    const answers = [{ enqueued: true }, { enqueued: false, reason: 'breaker_open' }, { enqueued: false }];
    const bodies: unknown[] = [];
    server.use(
      status(),
      emptyQuarantine,
      http.post(`${integrationUrl}/sync`, async ({ request }) => (bodies.push(await request.json()), HttpResponse.json(answers[bodies.length - 1], { status: 202 }))),
    );
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Sync started.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Syncing is paused after repeated errors. It will try again on its own.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('A sync is already queued.')).toBeInTheDocument();
    expect(bodies).toEqual([{ mode: 'incremental' }, { mode: 'incremental' }, { mode: 'incremental' }]);
  });

  it('W04 F3-25: "Full resync" asks first, then posts mode backfill', async () => {
    let body: unknown;
    server.use(status(), emptyQuarantine, http.post(`${integrationUrl}/sync`, async ({ request }) => ((body = await request.json()), HttpResponse.json({ enqueued: true }, { status: 202 }))));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Full resync' }));
    const dialog = await screen.findByRole('dialog', { name: 'Run a full resync?' });
    expect(body).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Start full resync' }));
    await waitFor(() => expect(body).toEqual({ mode: 'backfill' }));
    expect(await screen.findByText('Sync started.')).toBeInTheDocument();
  });

  it('W04 F3-26: 429 on sync shows the countdown from Retry-After', async () => {
    server.use(status(), emptyQuarantine, http.post(`${integrationUrl}/sync`, () => problemResponse(429, 'rate_limited', {}, { 'retry-after': '45' })));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText(/Too many requests. Try again in \d+ s./)).toBeInTheDocument();
  });

  it('W04 F3-27: 409 invalid_integration_transition says so and reads the integration again', async () => {
    let reads = 0;
    server.use(
      http.get(integrationUrl, () => (reads++, HttpResponse.json(integrationFixture()))),
      emptyQuarantine,
      http.post(`${integrationUrl}/sync`, () => problemResponse(409, 'invalid_integration_transition')),
    );
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText("This integration can't do that in its current state. The page has been refreshed.")).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
  });

  it('W04 F3-28: "Reconcile" posts and reports whether a run was enqueued', async () => {
    const answers = [{ enqueued: true }, { enqueued: false }];
    let calls = 0;
    server.use(status(), emptyQuarantine, http.post(`${integrationUrl}/reconcile`, () => HttpResponse.json(answers[calls++], { status: 202 })));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Reconcile' }));
    expect(await screen.findByText('Reconciliation started.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconcile' }));
    expect(await screen.findByText('A reconciliation is already running.')).toBeInTheDocument();
  });

  it('W04 F3-29: Pause posts to /pause and the status becomes "Paused by you" with a Resume button; Resume posts to /resume', async () => {
    let state: Record<string, unknown> = {};
    server.use(
      http.get(integrationUrl, () => HttpResponse.json(integrationFixture(state))),
      emptyQuarantine,
      http.post(`${integrationUrl}/pause`, () => ((state = { status: 'PAUSED', pausedReason: 'seller' }), HttpResponse.json(integrationFixture(state)))),
      http.post(`${integrationUrl}/resume`, () => ((state = {}), HttpResponse.json(integrationFixture(state)))),
    );
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Status' })).toHaveTextContent('Paused by you');
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('W04 F3-30: Disconnect asks first, sends DELETE (204) and goes back to the list', async () => {
    let deleted = false;
    server.use(status(), emptyQuarantine, http.delete(integrationUrl, () => ((deleted = true), new HttpResponse(null, { status: 204 }))));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect this store?' });
    expect(deleted).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect store' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(listUrl));
    expect(deleted).toBe(true);
  });

  it('W04 F3-31: a suspended shop disables the actions and says why', async () => {
    server.use(status(), emptyQuarantine);
    show(shopFixture({ status: 'SUSPENDED' }));
    expect(await screen.findByRole('button', { name: 'Sync now' })).toBeDisabled();
    expect(screen.getByText(/This shop is suspended/)).toBeInTheDocument();
  });

  it('W04 F3-32: an integration that needs reconnecting links to the connect forms instead of offering sync', async () => {
    server.use(status({ status: 'NEEDS_REAUTH' }), emptyQuarantine);
    show();
    expect(await screen.findByRole('link', { name: 'Reconnect this store' })).toHaveAttribute('href', listUrl);
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled();
  });
});

describe('W04 F3 quarantine', () => {
  it('W04 F3-33: lists open items with status, limit and cursor parameters, and the item text as plain text', async () => {
    let params: URLSearchParams | undefined;
    server.use(
      status(),
      http.get(`${integrationUrl}/quarantine`, ({ request }) => ((params = new URL(request.url).searchParams), HttpResponse.json(quarantinePage([quarantineFixture({ message: '<b>The product has no price.</b>' })], 'next-1')))),
    );
    show();
    const table = await screen.findByRole('table', { name: 'Quarantined items' });
    expect(params?.get('status')).toBe('OPEN');
    expect(params?.get('limit')).toBe('20');
    const row = within(table).getAllByRole('row')[1];
    expect(row).toHaveTextContent('gid://shopify/Product/1001');
    expect(row).toHaveTextContent('<b>The product has no price.</b>');
    expect(row).toHaveTextContent('3 times');
    expect(row).toHaveTextContent('Open');
    expect(row.querySelector('b')).toBeNull();
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', expect.stringContaining('cursor=next-1'));
  });

  it('W04 F3-34: the status filter writes the URL; a later page sends its cursor', async () => {
    search = 'tab=quarantine&status=RESOLVED&cursor=c2';
    let params: URLSearchParams | undefined;
    server.use(status(), http.get(`${integrationUrl}/quarantine`, ({ request }) => ((params = new URL(request.url).searchParams), HttpResponse.json(quarantinePage([quarantineFixture({ status: 'RESOLVED', resolution: 'fixed_at_provider', resolvedAt: '2026-10-17T09:00:00.000Z' })])))));
    const user = userEvent.setup();
    show();
    await screen.findByRole('table', { name: 'Quarantined items' });
    expect(params?.get('status')).toBe('RESOLVED');
    expect(params?.get('cursor')).toBe('c2');
    expect(screen.getByRole('table', { name: 'Quarantined items' })).toHaveTextContent('Fixed in the store');
    await user.selectOptions(screen.getByLabelText('Show'), 'DISMISSED');
    expect(push).toHaveBeenCalledWith(`/dashboard/seller/${SELLER_SHOP_ID}/integrations/${INTEGRATION_ID}?status=DISMISSED`);
  });

  it('W04 F3-35: Retry resolved, still_invalid and expired each say what happened', async () => {
    const answers = [
      { outcome: 'resolved', item: quarantineFixture({ status: 'RESOLVED', resolution: 'fixed_at_provider' }) },
      { outcome: 'still_invalid', item: quarantineFixture() },
      { outcome: 'resolved', item: quarantineFixture({ status: 'RESOLVED', resolution: 'expired' }) },
    ];
    let calls = 0;
    server.use(status(), http.get(`${integrationUrl}/quarantine`, () => HttpResponse.json(quarantinePage())), http.post(`${integrationUrl}/quarantine/${QUARANTINE_ID}/retry`, () => HttpResponse.json(answers[calls++])));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Retry gid://shopify/Product/1001' }));
    expect(await screen.findByText('The item passes now and was added.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry gid://shopify/Product/1001' }));
    expect(await screen.findByText('Still invalid. Fix it in the store, then retry.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry gid://shopify/Product/1001' }));
    expect(await screen.findByText('This item is gone from the store, so it was closed.')).toBeInTheDocument();
  });

  it('W04 F3-36: 409 quarantine_not_open says it was already handled and refreshes the list', async () => {
    let reads = 0;
    server.use(status(), http.get(`${integrationUrl}/quarantine`, () => (reads++, HttpResponse.json(quarantinePage()))), http.post(`${integrationUrl}/quarantine/${QUARANTINE_ID}/retry`, () => problemResponse(409, 'quarantine_not_open')));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Retry gid://shopify/Product/1001' }));
    expect(await screen.findByText('This item was already handled. The list has been refreshed.')).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(2));
  });

  it('W04 F3-37: Dismiss asks first and then posts', async () => {
    let dismissed = false;
    server.use(
      status(),
      http.get(`${integrationUrl}/quarantine`, () => HttpResponse.json(quarantinePage(dismissed ? [] : [quarantineFixture()]))),
      http.post(`${integrationUrl}/quarantine/${QUARANTINE_ID}/dismiss`, () => ((dismissed = true), HttpResponse.json(quarantineFixture({ status: 'DISMISSED', resolution: 'dismissed' })))),
    );
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Dismiss gid://shopify/Product/1001' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss this item?' });
    expect(dismissed).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss item' }));
    await waitFor(() => expect(screen.getByText('No open items.')).toBeInTheDocument());
  });
});

describe('W04 F3 stock conflicts of an integration', () => {
  it('W04 F3-38: lists the numbers of each conflict and dismisses an open one', async () => {
    search = 'tab=conflicts';
    let dismissed = false;
    server.use(
      status(),
      http.get(`${integrationUrl}/conflicts`, () => HttpResponse.json(conflictPage(dismissed ? [] : [stockConflictFixture()]))),
      http.post(`${integrationUrl}/conflicts/${CONFLICT_ID}/dismiss`, () => ((dismissed = true), HttpResponse.json(stockConflictFixture({ status: 'DISMISSED', dismissedAt: '2026-10-17T10:00:00.000Z' })))),
    );
    const user = userEvent.setup();
    show();
    const table = await screen.findByRole('table', { name: 'Stock conflicts' });
    const row = within(table).getAllByRole('row')[1];
    expect(row).toHaveTextContent('Oversold');
    expect(row).toHaveTextContent('Was 10, you changed it to 6, the store to 7');
    expect(row).toHaveTextContent('Resolved to 3');
    await user.click(within(row).getByRole('button', { name: 'Dismiss conflict for gid://shopify/Product/1001' }));
    await waitFor(() => expect(screen.getByText('No open conflicts.')).toBeInTheDocument());
  });

  it('W04 F3-39: 409 conflict_not_open reads as "already dismissed"', async () => {
    search = 'tab=conflicts';
    server.use(status(), http.get(`${integrationUrl}/conflicts`, () => HttpResponse.json(conflictPage())), http.post(`${integrationUrl}/conflicts/${CONFLICT_ID}/dismiss`, () => problemResponse(409, 'conflict_not_open')));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Dismiss conflict for gid://shopify/Product/1001' }));
    expect(await screen.findByText('This conflict was already dismissed. The list has been refreshed.')).toBeInTheDocument();
  });
});

describe('W04 F3 reconciliations', () => {
  it('W04 F3-40: lists the runs with outcome and counts, each linked to its report', async () => {
    search = 'tab=reconciliations';
    server.use(
      status(),
      http.get(`${integrationUrl}/reconciliations`, () => HttpResponse.json({ items: [reconciliationSummaryFixture(), reconciliationSummaryFixture({ id: PREVIOUS_RUN_ID, outcome: 'aborted_mass_delete', counts: {} })], nextCursor: null })),
    );
    show();
    const table = await screen.findByRole('table', { name: 'Reconciliations' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Completed');
    expect(rows[0]).toHaveTextContent('40 match');
    expect(rows[0]).toHaveTextContent('1 missing in the store');
    expect(within(rows[0]).getByRole('link', { name: 'View report' })).toHaveAttribute('href', expect.stringContaining(`run=${RUN_ID}`));
    expect(rows[1]).toHaveTextContent('Stopped: too many items missing in the store');
  });

  it('W04 F3-41: a report shows findings, carried-over findings as Fixed or Still open, the earlier run and the truncation note', async () => {
    search = `tab=reconciliations&run=${RUN_ID}`;
    server.use(
      status(),
      http.get(`${integrationUrl}/reconciliations`, () => HttpResponse.json({ items: [reconciliationSummaryFixture()], nextCursor: null })),
      http.get(`${integrationUrl}/reconciliations/${RUN_ID}`, () => HttpResponse.json(reconciliationReportFixture({ truncated: true }))),
    );
    show();
    const findings = await screen.findByRole('table', { name: 'Findings' });
    const rows = within(findings).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Missing in the store');
    expect(rows[0]).toHaveTextContent('Deleted in the store');
    expect(rows[1]).toHaveTextContent('Content differs');
    expect(rows[1]).toHaveTextContent('Fixed');
    expect(rows[2]).toHaveTextContent('Stock differs');
    expect(rows[2]).toHaveTextContent('Still open');
    expect(screen.getByText('Showing the first 1,000 findings. Fix some and run another reconciliation to see the rest.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Compare with the earlier run' })).toHaveAttribute('href', expect.stringContaining(`run=${PREVIOUS_RUN_ID}`));
  });

  it('W04 F3-42: 404 report_not_found reads as a sentence', async () => {
    search = `tab=reconciliations&run=${RUN_ID}`;
    server.use(
      status(),
      http.get(`${integrationUrl}/reconciliations`, () => HttpResponse.json({ items: [reconciliationSummaryFixture()], nextCursor: null })),
      http.get(`${integrationUrl}/reconciliations/${RUN_ID}`, () => problemResponse(404, 'report_not_found')),
    );
    show();
    expect(await screen.findByText('This reconciliation report is no longer available.')).toBeInTheDocument();
  });
});
