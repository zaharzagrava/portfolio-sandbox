import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncConflictPageSchema } from '@marketplace-sandbox/contracts';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { offlineConflictFixture, PRODUCT_ID, problemResponse } from '@/lib/test/seller-integrations-fixtures';
import { origin, SELLER_SHOP_ID, shopFixture } from '@/lib/test/seller-handlers';
import { OfflineConflictsView } from './offline-conflicts-view';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const push = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/integrations/offline-conflicts`,
  useSearchParams: () => new URLSearchParams(search),
}));

/** W04 F3 (S09 `contracts/http-api.md`): offline stock conflicts through the HTTP routes only, with no event subscription (R-14). */

const conflicts = `${origin}/api/shops/${SELLER_SHOP_ID}/sync/conflicts`;
const OP = offlineConflictFixture().opId;
const page = (items = [offlineConflictFixture()], nextCursor: string | null = null) => syncConflictPageSchema.parse({ items, nextCursor });

let client: QueryClient;
function show(shop = shopFixture()) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shop)));
  return render(
    <QueryClientProvider client={client}>
      <OfflineConflictsView shopId={SELLER_SHOP_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  search = '';
  vi.clearAllMocks();
});

describe('W04 F3 offline conflicts', () => {
  it('W04 F3-50: lists open conflicts with the numbers of each, asking with status=open and a limit', async () => {
    let params: URLSearchParams | undefined;
    server.use(http.get(conflicts, ({ request }) => ((params = new URL(request.url).searchParams), HttpResponse.json(page([offlineConflictFixture()], 'n2')))));
    show();
    const table = await screen.findByRole('table', { name: 'Offline stock conflicts' });
    expect(params?.get('status')).toBe('open');
    expect(params?.get('limit')).toBe('20');
    const row = within(table).getAllByRole('row')[1];
    expect(row).toHaveTextContent('pos-device-1');
    expect(row).toHaveTextContent('Oversold');
    expect(row).toHaveTextContent('Asked for -5, applied -3, short by 2');
    expect(row).toHaveTextContent('Stock after: 0');
    expect(row).toHaveTextContent(PRODUCT_ID);
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', expect.stringContaining('cursor=n2'));
  });

  it('W04 F3-51: the status filter writes the URL; dismissed is asked for with status=dismissed', async () => {
    search = 'status=dismissed&cursor=c1';
    let params: URLSearchParams | undefined;
    server.use(http.get(conflicts, ({ request }) => ((params = new URL(request.url).searchParams), HttpResponse.json(page([offlineConflictFixture({ status: 'dismissed', dismissedAt: '2026-10-17T08:00:00.000Z' })])))));
    const user = userEvent.setup();
    show();
    await screen.findByRole('table', { name: 'Offline stock conflicts' });
    expect(params?.get('status')).toBe('dismissed');
    expect(params?.get('cursor')).toBe('c1');
    expect(screen.queryByRole('button', { name: /Dismiss conflict/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Show'), 'open');
    expect(push).toHaveBeenCalledWith(`/dashboard/seller/${SELLER_SHOP_ID}/integrations/offline-conflicts`);
  });

  it('W04 F3-52: Dismiss posts to …/conflicts/:opId/dismiss and the row leaves the open list', async () => {
    let dismissed = false;
    server.use(
      http.get(conflicts, () => HttpResponse.json(page(dismissed ? [] : [offlineConflictFixture()]))),
      http.post(`${conflicts}/${OP}/dismiss`, () => ((dismissed = true), HttpResponse.json(offlineConflictFixture({ status: 'dismissed', dismissedAt: '2026-10-17T08:00:00.000Z' })))),
    );
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: `Dismiss conflict for ${PRODUCT_ID}` }));
    await waitFor(() => expect(screen.getByText('No open conflicts.')).toBeInTheDocument());
    expect(dismissed).toBe(true);
  });

  it('W04 F3-53: 409 conflict_not_open and 429 read as sentences and never show the API detail', async () => {
    server.use(http.get(conflicts, () => HttpResponse.json(page())), http.post(`${conflicts}/${OP}/dismiss`, () => problemResponse(409, 'conflict_not_open')));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: `Dismiss conflict for ${PRODUCT_ID}` }));
    expect(await screen.findByText('This conflict was already dismissed. The list has been refreshed.')).toBeInTheDocument();
    server.use(http.post(`${conflicts}/${OP}/dismiss`, () => problemResponse(429, 'rate_limited', {}, { 'retry-after': '20' })));
    await user.click(await screen.findByRole('button', { name: `Dismiss conflict for ${PRODUCT_ID}` }));
    expect(await screen.findByText(/Too many requests. Try again in \d+ s./)).toBeInTheDocument();
    expect(screen.queryByText('Never shown detail')).not.toBeInTheDocument();
  });

  it('W04 F3-54: a member without products.write sees the conflicts and no Dismiss button', async () => {
    server.use(http.get(conflicts, () => HttpResponse.json(page())));
    show(shopFixture({ myRole: 'VIEWER', myPermissions: ['shop.read', 'products.read'] }));
    await screen.findByRole('table', { name: 'Offline stock conflicts' });
    expect(screen.queryByRole('button', { name: /Dismiss conflict/ })).not.toBeInTheDocument();
  });

  it('W04 F3-55: with no conflicts the empty text shows; a failed list shows the problem with Try again', async () => {
    server.use(http.get(conflicts, () => HttpResponse.json(page([]))));
    const first = show();
    expect(await screen.findByText('No open conflicts.')).toBeInTheDocument();
    first.unmount();
    client.clear();
    server.use(http.get(conflicts, () => problemResponse(400, 'invalid_cursor')));
    show();
    expect(await screen.findByText('That page link is no longer valid.')).toBeInTheDocument();
  });
});
