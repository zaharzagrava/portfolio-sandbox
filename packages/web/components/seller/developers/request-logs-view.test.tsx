import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { readLogsParams } from '@/lib/seller/search-params';
import { installClipboardStub } from '@/lib/test/clipboard-stub';
import { KEY_ID, keyFixture, logRowFixture } from '@/lib/test/seller-developers-fixtures';
import { origin, SELLER_SHOP_ID, sellerProblem, shopFixture } from '@/lib/test/seller-handlers';
import { RequestLogsView } from './request-logs-view';

const push = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/developers/logs`,
  useSearchParams: () => new URLSearchParams(search),
}));

const PATH = `/dashboard/seller/${SELLER_SHOP_ID}/developers/logs`;
const dev = `${origin}/api/shops/${SELLER_SHOP_ID}/developers`;

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

let client: QueryClient;
function show() {
  const shop = shopFixture();
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(
    http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shop)),
    http.get(`${dev}/keys`, () => HttpResponse.json({ items: [keyFixture()], nextCursor: null })),
  );
  return render(
    <QueryClientProvider client={client}>
      <RequestLogsView shopId={SELLER_SHOP_ID} serverParams={readLogsParams(Object.fromEntries(new URLSearchParams(search)))} />
    </QueryClientProvider>,
  );
}
const logs = (items: ReturnType<typeof logRowFixture>[], nextCursor: string | null = null) => http.get(`${dev}/logs`, () => HttpResponse.json({ items, nextCursor }));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  search = '';
  vi.clearAllMocks();
  installClipboardStub('granted');
});

describe('W04 request logs', () => {
  it('W04 AS-70: the table shows the columns, the deprecated flag and the error code, and Next page carries the cursor', async () => {
    server.use(logs([logRowFixture(), logRowFixture({ requestId: 'req_2', status: 429, deprecated: true, errorCode: 'rate_limited', livemode: true })], 'c2'));
    show();
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(
      expect.arrayContaining(['Time', 'Method', 'Route', 'Status', 'Duration', 'Version', 'Key', 'Mode', 'Error']),
    );
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('/v1/products');
    expect(rows[0]).toHaveTextContent('GET');
    expect(rows[0]).toHaveTextContent('Test');
    expect(rows[1]).toHaveTextContent('Deprecated');
    expect(rows[1]).toHaveTextContent('rate_limited');
    expect(rows[1]).toHaveTextContent('Live');
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', `${PATH}?cursor=c2`);
  });

  it('W04 AS-70: Apply writes the filters to the URL without defaults and without the cursor; Clear filters resets', async () => {
    search = 'cursor=c1';
    server.use(logs([logRowFixture()]));
    const user = userEvent.setup();
    show();
    await screen.findByRole('table');
    await user.type(screen.getByLabelText('Request ID'), 'req_1');
    await user.selectOptions(screen.getByLabelText('Status'), '4xx');
    await user.type(screen.getByLabelText('Route'), '/v1/products');
    await user.selectOptions(screen.getByLabelText('Mode'), 'false');
    await user.type(screen.getByLabelText('From'), day(-3));
    await user.type(screen.getByLabelText('To'), day(-1));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(push).toHaveBeenCalledWith(`${PATH}?requestId=req_1&status=4xx&route=%2Fv1%2Fproducts&livemode=false&from=${day(-3)}&to=${day(-1)}`);
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(push).toHaveBeenLastCalledWith(PATH);
  });

  it('W04 AS-70: the key filter lists the shop keys and the URL filters fill the form and are sent to the API', async () => {
    search = `status=429&keyId=${KEY_ID}&livemode=true`;
    let seen: URL | undefined;
    server.use(
      http.get(`${dev}/logs`, ({ request }) => ((seen = new URL(request.url)), HttpResponse.json({ items: [logRowFixture({ status: 429 }), logRowFixture({ requestId: 'req_x', status: 403 })], nextCursor: null }))),
    );
    show();
    const table = await screen.findByRole('table');
    expect(screen.getByLabelText('Status')).toHaveValue('429');
    expect(screen.getByLabelText('Key')).toHaveValue(KEY_ID);
    expect(screen.getByLabelText('Mode')).toHaveValue('true');
    expect(seen?.searchParams.get('status')).toBe('4xx');
    expect(seen?.searchParams.get('keyId')).toBe(KEY_ID);
    // "429" asks for 4xx and keeps only the throttled rows.
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(1);
  });

  it('W04 AS-71: the dates allow only the last 30 days and To cannot be earlier than From', async () => {
    server.use(logs([logRowFixture()]));
    const user = userEvent.setup();
    show();
    await screen.findByRole('table');
    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    expect(from).toHaveAttribute('min', day(-30));
    expect(from).toHaveAttribute('max', day(0));
    expect(to).toHaveAttribute('min', day(-30));
    expect(to).toHaveAttribute('max', day(0));
    await user.type(from, day(-5));
    expect(to).toHaveAttribute('min', day(-5));
    expect(from).toHaveAttribute('max', day(0));
  });

  it('W04 AS-71: a 400 for a filter shows under that filter', async () => {
    search = 'requestId=bad';
    server.use(http.get(`${dev}/logs`, () => sellerProblem('validation_failed', { errors: [{ field: 'requestId', code: 'invalid' }] })));
    show();
    const field = await screen.findByLabelText('Request ID');
    await waitFor(() => expect(field).toHaveAccessibleDescription('Check this field.'));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('W04 AS-72: a row opens details with the request id and a Copy button, the client id and the error code, and no body', async () => {
    server.use(logs([logRowFixture({ clientRequestId: 'client-77', errorCode: 'validation_failed', status: 400 })]));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Details for req_8f2a' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request details' });
    expect(dialog).toHaveTextContent('req_8f2a');
    expect(dialog).toHaveTextContent('client-77');
    expect(dialog).toHaveTextContent('validation_failed');
    expect(dialog).not.toHaveTextContent(/body|header|authorization/i);
    await user.click(within(dialog).getByRole('button', { name: 'Copy request ID' }));
    expect(await within(dialog).findByText('Copied to clipboard')).toBeInTheDocument();
  });

  it('W04 AS-72: no result, including another shop\'s request id, shows "No matching requests."', async () => {
    search = 'requestId=req_other_shop';
    server.use(logs([]));
    show();
    expect(await screen.findByText('No matching requests.')).toBeInTheDocument();
  });
});
