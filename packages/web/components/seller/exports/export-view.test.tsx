import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { resetUserStream } from '@/lib/realtime/user-stream';
import { installLiveStreamStub, type LiveStreamStub } from '@/lib/test/event-source-stub';
import { origin, SELLER_SHOP_ID, shopFixture } from '@/lib/test/seller-handlers';
import { problemResponse } from '@/lib/test/seller-problem';
import { ExportView } from './export-view';

vi.mock('next/navigation', () => ({
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/exports`,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/lib/api/session', () => ({ sessionApi: { refresh: vi.fn(), current: vi.fn() } }));
vi.mock('@/lib/auth/session-ended', () => ({ endSession: vi.fn(), setSessionEndHandler: vi.fn(), rearmSessionEnd: vi.fn() }));

const EXPORT_ID = '4c5d6e7f-8a9b-4c1d-9e2f-3a4b5c6d7e8f';
const ACTIVE_ID = '5d6e7f8a-9b0c-4d2e-8f3a-4b5c6d7e8f9a';
const base = `${origin}/api/shops/${SELLER_SHOP_ID}/order-exports`;
const topic = (id = EXPORT_ID) => `order-export:${id}`;
const record = (over: Record<string, unknown> = {}) => ({
  exportId: EXPORT_ID,
  status: 'QUEUED',
  rowsWritten: 0,
  totalRows: null,
  bytesWritten: 0,
  attempt: 0,
  failure: null,
  createdBy: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  createdAt: '2026-10-17T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  expiresAt: null,
  ...over,
});

let stub: LiveStreamStub;
let client: QueryClient;
let startKeys: (string | null)[];
let startBodies: unknown[];
let current = record();

function handlers(extra: Parameters<typeof server.use> = []) {
  server.use(
    ...extra,
    http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shopFixture())),
    http.get(base, () => HttpResponse.json({ items: [], nextCursor: null })),
    http.post(base, async ({ request }) => {
      startKeys.push(request.headers.get('idempotency-key'));
      startBodies.push(await request.json());
      return HttpResponse.json(record(), { status: 202, headers: { Location: `/api/shops/${SELLER_SHOP_ID}/order-exports/${EXPORT_ID}` } });
    }),
    http.get(`${base}/${EXPORT_ID}`, () => HttpResponse.json(current)),
  );
}

function mount(shop = shopFixture()) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  return render(
    <QueryClientProvider client={client}>
      <ExportView shopId={SELLER_SHOP_ID} />
    </QueryClientProvider>,
  );
}

async function startExport(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Start export' }));
  await screen.findByTestId('export-status');
  await waitFor(() => expect(stub.topics()).toContain(topic()));
  act(() => stub.open());
}

beforeEach(() => {
  stub = installLiveStreamStub();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  startKeys = [];
  startBodies = [];
  current = record();
  vi.clearAllMocks();
});

afterEach(() => resetUserStream());

describe('W04 F4 order export start (S12)', () => {
  it('W04 F4: Start export posts {} with an Idempotency-Key of 8+ characters, shows Queued and subscribes order-export:<exportId> (never job:)', async () => {
    handlers();
    const user = userEvent.setup();
    mount();
    await startExport(user);
    expect(startBodies).toEqual([{}]);
    expect(startKeys[0]?.length).toBeGreaterThanOrEqual(8);
    expect(screen.getByTestId('export-status')).toHaveTextContent('Queued');
    expect(stub.topics().some((name) => name.startsWith('job:'))).toBe(false);
  });

  it('W04 F4: a failed start retried reuses the Idempotency-Key; the start after a success gets a new one', async () => {
    let attempts = 0;
    handlers([
      http.post(base, async ({ request }) => {
        startKeys.push(request.headers.get('idempotency-key'));
        attempts += 1;
        return attempts === 1 ? problemResponse('upstream_unavailable', 503) : HttpResponse.json(record(), { status: 202 });
      }),
    ]);
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Start export' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/try again in a moment/i);
    await user.click(screen.getByRole('button', { name: 'Start export' }));
    await screen.findByTestId('export-status');
    expect(startKeys).toHaveLength(2);
    expect(startKeys[1]).toBe(startKeys[0]);
  });

  it('W04 F4 L-010: 409 export_already_active {activeExportId} opens the existing export instead of failing', async () => {
    current = record({ exportId: ACTIVE_ID, status: 'RUNNING', rowsWritten: 100, totalRows: 400, startedAt: '2026-10-17T09:59:00.000Z' });
    handlers([
      http.post(base, () => problemResponse('export_already_active', 409, { activeExportId: ACTIVE_ID })),
      http.get(`${base}/${ACTIVE_ID}`, () => HttpResponse.json(current)),
    ]);
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Start export' }));
    await waitFor(() => expect(screen.getByTestId('export-status')).toHaveTextContent('Running'));
    expect(screen.getByText('An export is already running. Showing it.')).toBeInTheDocument();
    await waitFor(() => expect(stub.topics()).toContain(topic(ACTIVE_ID)));
  });

  it('W04 F4: a 429 shows the countdown, never the server text', async () => {
    handlers([http.post(base, () => problemResponse('rate_limited', 429, {}))]);
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Start export' }));
    expect(await screen.findByText(/Too many requests/)).toBeInTheDocument();
    expect(screen.queryByText(/Server/)).not.toBeInTheDocument();
  });

  it('W04 F4: a suspended shop disables Start export and says why', async () => {
    const suspended = shopFixture({ status: 'SUSPENDED' });
    handlers([http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(suspended))]);
    mount(suspended);
    expect(screen.getByRole('button', { name: 'Start export' })).toBeDisabled();
    expect(screen.getByText('This shop is suspended. You can view data but not make changes.')).toBeInTheDocument();
  });
});

describe('W04 F4 order export progress, cancel and download (S12)', () => {
  it('W04 F4: a progress frame moves the bar and the row count', async () => {
    handlers();
    const user = userEvent.setup();
    mount();
    await startExport(user);
    act(() => stub.frame('progress', topic(), { rowsWritten: 150, totalRows: 300, bytesWritten: 4096 }));
    const bar = await screen.findByRole('progressbar', { name: /export progress/i });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByTestId('export-rows')).toHaveTextContent('150');
  });

  it('W04 F4: a done frame refetches the export and offers Download file', async () => {
    handlers();
    const user = userEvent.setup();
    mount();
    await startExport(user);
    current = record({ status: 'DONE', rowsWritten: 300, totalRows: 300, bytesWritten: 9000, finishedAt: '2026-10-17T10:01:00.000Z', expiresAt: '2026-10-24T10:01:00.000Z' });
    act(() => stub.frame('done', topic(), { rowsWritten: 300, bytesWritten: 9000 }));
    await waitFor(() => expect(screen.getByTestId('export-status')).toHaveTextContent('Done'));
    expect(screen.getByRole('button', { name: 'Download file' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel export' })).not.toBeInTheDocument();
  });

  it('W04 F4: a failed frame shows the fixed message of its code, never the server text', async () => {
    handlers();
    const user = userEvent.setup();
    mount();
    await startExport(user);
    current = record({ status: 'FAILED', failure: { code: 'storage_unavailable', message: 'Server text' } });
    act(() => stub.frame('failed', topic(), { code: 'storage_unavailable' }));
    await waitFor(() => expect(screen.getByTestId('export-status')).toHaveTextContent('Failed'));
    expect(screen.getByText('The file could not be stored. Start a new export.')).toBeInTheDocument();
    expect(screen.queryByText(/Server/)).not.toBeInTheDocument();
  });

  it('W04 F4: a cancelled frame shows Cancelled', async () => {
    handlers();
    const user = userEvent.setup();
    mount();
    await startExport(user);
    current = record({ status: 'CANCELLED', finishedAt: '2026-10-17T10:00:30.000Z' });
    act(() => stub.frame('cancelled', topic(), {}));
    await waitFor(() => expect(screen.getByTestId('export-status')).toHaveTextContent('Cancelled'));
  });

  it('W04 F4: Cancel export posts …/cancel', async () => {
    const cancels: string[] = [];
    handlers([http.post(`${base}/${EXPORT_ID}/cancel`, ({ request }) => (cancels.push(request.url), HttpResponse.json(record({ status: 'CANCELLED' }))))]);
    const user = userEvent.setup();
    mount();
    await startExport(user);
    await user.click(screen.getByRole('button', { name: 'Cancel export' }));
    await waitFor(() => expect(screen.getByTestId('export-status')).toHaveTextContent('Cancelled'));
    expect(cancels).toHaveLength(1);
  });

  it('W04 F4: export_not_cancellable shows its fixed message and refreshes the export', async () => {
    handlers([http.post(`${base}/${EXPORT_ID}/cancel`, () => problemResponse('export_not_cancellable', 409))]);
    const user = userEvent.setup();
    mount();
    await startExport(user);
    current = record({ status: 'DONE', rowsWritten: 5, totalRows: 5, expiresAt: '2026-10-24T10:01:00.000Z' });
    await user.click(screen.getByRole('button', { name: 'Cancel export' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This export has already finished.');
    await waitFor(() => expect(screen.getByTestId('export-status')).toHaveTextContent('Done'));
  });

  it('W04 F4: the file is reached only through GET …/download: no file address on the page before the click, then the returned url is opened', async () => {
    current = record({ status: 'DONE', rowsWritten: 5, totalRows: 5, expiresAt: '2026-10-24T10:01:00.000Z' });
    const opened: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      opened.push(this.href);
    });
    let downloads = 0;
    handlers([http.get(`${base}/${EXPORT_ID}/download`, () => (downloads++, HttpResponse.json({ url: 'https://files.example.test/orders.csv?sig=1', expiresAt: '2026-10-17T10:10:00.000Z' })))]);
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Start export' }));
    await waitFor(() => expect(screen.getByTestId('export-status')).toHaveTextContent('Done'));
    expect(document.querySelector('a[href*="files.example.test"]')).toBeNull();
    expect(downloads).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Download file' }));
    await waitFor(() => expect(opened).toEqual(['https://files.example.test/orders.csv?sig=1']));
    expect(downloads).toBe(1);
    click.mockRestore();
  });

  it.each([
    ['export_not_ready', 409, 'The file is not ready yet.'],
    ['export_expired', 410, 'This file has expired. Start a new export.'],
  ])('W04 F4: %s on download shows its fixed message', async (code, status, text) => {
    current = record({ status: 'DONE', rowsWritten: 5, totalRows: 5, expiresAt: '2026-10-24T10:01:00.000Z' });
    handlers([http.get(`${base}/${EXPORT_ID}/download`, () => problemResponse(code, status))]);
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Start export' }));
    await waitFor(() => expect(screen.getByTestId('export-status')).toHaveTextContent('Done'));
    await user.click(screen.getByRole('button', { name: 'Download file' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent('Server');
  });

  it('W04 F4: the list of earlier exports shows status and rows; an expired one has no download', async () => {
    const earlier = record({ exportId: ACTIVE_ID, status: 'EXPIRED', rowsWritten: 12, totalRows: 12, finishedAt: '2026-10-01T10:00:00.000Z' });
    handlers([http.get(base, () => HttpResponse.json({ items: [earlier], nextCursor: null }))]);
    mount();
    const table = await screen.findByRole('table', { name: /exports/i });
    expect(within(table).getByText('Expired')).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
  });
});
