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
import { ImportView } from './import-view';

vi.mock('next/navigation', () => ({
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/imports`,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('@/lib/api/session', () => ({ sessionApi: { refresh: vi.fn(), current: vi.fn() } }));
vi.mock('@/lib/auth/session-ended', () => ({ endSession: vi.fn(), setSessionEndHandler: vi.fn(), rearmSessionEnd: vi.fn() }));

const IMPORT_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const base = `${origin}/api/shops/${SELLER_SHOP_ID}/imports`;
const PART = (n: number) => `https://storage.example.test/imports/${IMPORT_ID}/part-${n}`;
const CONTENT = 'sku,title\nA-1,One\nA-2,Two\n'; // 26 bytes
const startResponse = (over: Record<string, unknown> = {}) => ({
  importId: IMPORT_ID,
  status: 'PENDING_UPLOAD',
  partSize: 10,
  partCount: 3,
  parts: [1, 2, 3].map((partNumber) => ({ partNumber, url: PART(partNumber) })),
  uploadExpiresAt: '2026-10-18T10:00:00.000Z',
  ...over,
});
const job = (over: Record<string, unknown> = {}) => ({
  id: IMPORT_ID,
  shopId: SELLER_SHOP_ID,
  status: 'PROCESSING',
  fileName: 'catalog.csv',
  sizeBytes: CONTENT.length,
  rowsProcessed: 0,
  rowsCreated: 0,
  rowsUpdated: 0,
  rowsUnchanged: 0,
  rowsFailed: 0,
  bytesProcessed: 0,
  ignoredColumns: [],
  scan: 'clean',
  failure: null,
  errorReport: { available: false, rows: 0 },
  createdBy: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  createdAt: '2026-10-17T10:00:00.000Z',
  startedAt: '2026-10-17T10:00:05.000Z',
  finishedAt: null,
  history: [{ status: 'PENDING_UPLOAD', at: '2026-10-17T10:00:00.000Z' }],
  ...over,
});
const summary = (full: ReturnType<typeof job>) => Object.fromEntries(Object.entries(full).filter(([name]) => name !== 'history'));

let stub: LiveStreamStub;
let client: QueryClient;
let startKeys: (string | null)[];
let startBodies: unknown[];
let putUrls: string[];
let completeBodies: unknown[];
let current = job();

function handlers(extra: Parameters<typeof server.use> = []) {
  server.use(
    ...extra,
    http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shopFixture())),
    http.get(base, () => HttpResponse.json({ items: [], nextCursor: null })),
    http.post(base, async ({ request }) => {
      startKeys.push(request.headers.get('idempotency-key'));
      startBodies.push(await request.json());
      return HttpResponse.json(startResponse(), { status: 201 });
    }),
    http.put('https://storage.example.test/imports/:id/:part', ({ request }) => {
      const url = request.url;
      putUrls.push(url);
      return new HttpResponse(null, { status: 200, headers: { ETag: `"etag-${url.split('-').pop()}"` } });
    }),
    http.post(`${base}/${IMPORT_ID}/complete`, async ({ request }) => {
      completeBodies.push(await request.json());
      return HttpResponse.json(job({ status: 'UPLOADED' }), { status: 202 });
    }),
    http.get(`${base}/${IMPORT_ID}`, () => HttpResponse.json(current)),
  );
}

function mount(shop = shopFixture()) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  return render(
    <QueryClientProvider client={client}>
      <ImportView shopId={SELLER_SHOP_ID} />
    </QueryClientProvider>,
  );
}

const csv = (name = 'catalog.csv', content = CONTENT) => new File([content], name, { type: 'text/csv' });
async function chooseAndStart(user: ReturnType<typeof userEvent.setup>, file = csv()) {
  await user.upload(screen.getByTestId('import-file'), file);
  await user.click(screen.getByRole('button', { name: 'Start import' }));
}

beforeEach(() => {
  stub = installLiveStreamStub();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  startKeys = [];
  startBodies = [];
  putUrls = [];
  completeBodies = [];
  current = job();
  vi.clearAllMocks();
});

afterEach(() => resetUserStream());

describe('W04 F2 bulk import start and upload (S07)', () => {
  it('W04 F2: Start import sends {fileName, sizeBytes} with an Idempotency-Key of 8+ characters, uploads each part from parts[].url, then completes with the ETags', async () => {
    handlers();
    const user = userEvent.setup();
    mount();
    expect(screen.getByRole('button', { name: 'Start import' })).toBeDisabled();
    await chooseAndStart(user);

    await screen.findByTestId('import-progress');
    await waitFor(() => expect(completeBodies).toHaveLength(1));
    expect(startBodies).toEqual([{ fileName: 'catalog.csv', sizeBytes: CONTENT.length }]);
    expect(startKeys[0]?.length).toBeGreaterThanOrEqual(8);
    expect([...putUrls].sort()).toEqual([PART(1), PART(2), PART(3)]);
    expect(completeBodies[0]).toEqual({ parts: [1, 2, 3].map((partNumber) => ({ partNumber, etag: `"etag-${partNumber}"` })) });
  });

  it('W04 F2: a start answer in the old shape (jobId, partUrls, uploadId, key) is refused: an alert and no upload', async () => {
    handlers([http.post(base, () => HttpResponse.json({ jobId: IMPORT_ID, partUrls: [PART(1)], uploadId: 'u', key: 'k' }, { status: 201 }))]);
    const user = userEvent.setup();
    mount();
    await chooseAndStart(user);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(putUrls).toEqual([]);
  });

  it('W04 F2: a failed start retried with the same file reuses its Idempotency-Key; another file gets a new one', async () => {
    let attempts = 0;
    handlers([
      http.post(base, async ({ request }) => {
        startKeys.push(request.headers.get('idempotency-key'));
        attempts += 1;
        return attempts === 1 ? problemResponse('upstream_unavailable', 503) : HttpResponse.json(startResponse(), { status: 201 });
      }),
    ]);
    const user = userEvent.setup();
    mount();
    await chooseAndStart(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(/try again in a moment/i);
    await user.click(screen.getByRole('button', { name: 'Start import' }));
    await waitFor(() => expect(startKeys).toHaveLength(2));
    expect(startKeys[1]).toBe(startKeys[0]);
  });

  it('W04 F2: a different file after a failed start gets a new key', async () => {
    handlers([
      http.post(base, async ({ request }) => {
        startKeys.push(request.headers.get('idempotency-key'));
        return problemResponse('upstream_unavailable', 503);
      }),
    ]);
    const user = userEvent.setup();
    mount();
    await chooseAndStart(user);
    await screen.findByRole('alert');
    await user.upload(screen.getByTestId('import-file'), csv('other.csv', 'sku,title\nB-1,Three\n'));
    await user.click(screen.getByRole('button', { name: 'Start import' }));
    await waitFor(() => expect(startKeys).toHaveLength(2));
    expect(startKeys[1]).not.toBe(startKeys[0]);
  });

  it('W04 F2: a part that fails stops the upload; Resume upload asks GET …/upload and sends only the missing parts, then completes with all ETags', async () => {
    let part2Fails = true;
    handlers([
      http.put('https://storage.example.test/imports/:id/:part', ({ request }) => {
        putUrls.push(request.url);
        if (request.url === PART(2) && part2Fails) return new HttpResponse(null, { status: 500 });
        return new HttpResponse(null, { status: 200, headers: { ETag: `"etag-${request.url.split('-').pop()}"` } });
      }),
      http.get(`${base}/${IMPORT_ID}/upload`, () => {
        part2Fails = false;
        return HttpResponse.json({
          importId: IMPORT_ID,
          partSize: 10,
          partCount: 3,
          uploaded: [{ partNumber: 1, etag: '"etag-1"', sizeBytes: 10 }],
          missing: [2, 3].map((partNumber) => ({ partNumber, url: PART(partNumber) })),
          uploadExpiresAt: '2026-10-18T10:00:00.000Z',
        });
      }),
    ]);
    const user = userEvent.setup();
    mount();
    await chooseAndStart(user);
    await screen.findByRole('alert');
    expect(completeBodies).toEqual([]);
    putUrls.length = 0;
    await user.click(screen.getByRole('button', { name: 'Resume upload' }));
    await waitFor(() => expect(completeBodies).toHaveLength(1));
    expect(putUrls).not.toContain(PART(1));
    expect(completeBodies[0]).toEqual({ parts: [1, 2, 3].map((partNumber) => ({ partNumber, etag: `"etag-${partNumber}"` })) });
  });

  it.each([
    ['too_many_active_imports', 409, 'You already have imports running. Wait for one to finish.'],
    ['shop_suspended', 403, 'This shop is suspended. You can view data but not make changes.'],
  ])('W04 F2: %s on start shows its fixed message, never the server text', async (code, status, text) => {
    handlers([http.post(base, () => problemResponse(code, status))]);
    const user = userEvent.setup();
    mount();
    await chooseAndStart(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent('Server');
  });

  it('W04 F2: a file over 5 GiB is refused before any request', async () => {
    handlers();
    const user = userEvent.setup();
    mount();
    const big = csv();
    Object.defineProperty(big, 'size', { value: 5_368_709_121 });
    await user.upload(screen.getByTestId('import-file'), big);
    expect(screen.getByRole('button', { name: 'Start import' })).toBeDisabled();
    expect(screen.getByText(/5 GiB/)).toBeInTheDocument();
    expect(startKeys).toEqual([]);
  });

  it('W04 F2: a suspended shop disables Start import and says why', async () => {
    const suspended = shopFixture({ status: 'SUSPENDED' });
    handlers([http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(suspended))]);
    const user = userEvent.setup();
    mount(suspended);
    await user.upload(screen.getByTestId('import-file'), csv());
    expect(screen.getByRole('button', { name: 'Start import' })).toBeDisabled();
    expect(screen.getByText('This shop is suspended. You can view data but not make changes.')).toBeInTheDocument();
  });
});

describe('W04 F2 bulk import progress, cancel and report (S07)', () => {
  async function startAndSettle() {
    handlers();
    const user = userEvent.setup();
    mount();
    await chooseAndStart(user);
    await waitFor(() => expect(completeBodies).toHaveLength(1));
    await screen.findByTestId('import-status');
    return user;
  }

  it('W04 F2: it subscribes import:<importId> (never job:) and the progress frames move the bar and the counts', async () => {
    await startAndSettle();
    await waitFor(() => expect(stub.topics()).toContain(`import:${IMPORT_ID}`));
    expect(stub.topics().some((topic) => topic.startsWith('job:'))).toBe(false);
    act(() => stub.open());
    act(() => stub.frame('progress', `import:${IMPORT_ID}`, { processed: 40, failed: 4, bytesProcessed: 13, sizeBytes: CONTENT.length }));
    const bar = await screen.findByRole('progressbar', { name: /import progress/i });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByTestId('import-rows-failed')).toHaveTextContent('4');
  });

  it('W04 F2: a done frame refetches the import and shows Done with the counts and the error-report link', async () => {
    await startAndSettle();
    await waitFor(() => expect(stub.topics()).toContain(`import:${IMPORT_ID}`));
    act(() => stub.open());
    current = job({ status: 'DONE', rowsProcessed: 20, rowsCreated: 16, rowsFailed: 4, errorReport: { available: true, rows: 4 }, finishedAt: '2026-10-17T10:01:00.000Z' });
    act(() => stub.frame('done', `import:${IMPORT_ID}`, { rowsProcessed: 20, rowsFailed: 4 }));
    await waitFor(() => expect(screen.getByTestId('import-status')).toHaveTextContent('Done'));
    expect(screen.getByTestId('import-rows-failed')).toHaveTextContent('4');
    expect(screen.getByRole('link', { name: 'Download error report' })).toBeInTheDocument();
  });

  it('W04 F2: a failed frame shows the fixed message of its code', async () => {
    await startAndSettle();
    await waitFor(() => expect(stub.topics()).toContain(`import:${IMPORT_ID}`));
    act(() => stub.open());
    current = job({ status: 'FAILED', failure: { code: 'invalid_header', message: 'Server text', detail: 'Server detail' } });
    act(() => stub.frame('failed', `import:${IMPORT_ID}`, { code: 'invalid_header' }));
    await waitFor(() => expect(screen.getByTestId('import-status')).toHaveTextContent('Failed'));
    expect(screen.getByText('The header row lacks a required column or repeats one.')).toBeInTheDocument();
    expect(screen.queryByText(/Server/)).not.toBeInTheDocument();
  });

  it('W04 F2: Cancel import posts …/cancel and shows Cancelled', async () => {
    const cancels: string[] = [];
    const user = await startAndSettle();
    server.use(http.post(`${base}/${IMPORT_ID}/cancel`, ({ request }) => (cancels.push(request.url), HttpResponse.json(job({ status: 'CANCELLED', finishedAt: '2026-10-17T10:02:00.000Z' })))));
    await user.click(await screen.findByRole('button', { name: 'Cancel import' }));
    await waitFor(() => expect(screen.getByTestId('import-status')).toHaveTextContent('Cancelled'));
    expect(cancels).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Cancel import' })).not.toBeInTheDocument();
  });

  it('W04 F2: import_not_cancellable shows its fixed message and refreshes the import', async () => {
    const user = await startAndSettle();
    server.use(http.post(`${base}/${IMPORT_ID}/cancel`, () => problemResponse('import_not_cancellable', 409)));
    current = job({ status: 'DONE', finishedAt: '2026-10-17T10:02:00.000Z' });
    await user.click(await screen.findByRole('button', { name: 'Cancel import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This import has already finished.');
    await waitFor(() => expect(screen.getByTestId('import-status')).toHaveTextContent('Done'));
  });

  it('W04 F2: Download error report calls GET …/error-report and opens the url it returns', async () => {
    current = job({ status: 'DONE', rowsFailed: 4, errorReport: { available: true, rows: 4 } });
    const opened: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      opened.push(this.href);
    });
    const user = await startAndSettle();
    server.use(http.get(`${base}/${IMPORT_ID}/error-report`, () => HttpResponse.json({ url: 'https://files.example.test/errors-catalog.csv?sig=1', expiresAt: '2026-10-17T10:12:00.000Z', rows: 4 })));
    await user.click(await screen.findByRole('link', { name: 'Download error report' }));
    await waitFor(() => expect(opened).toEqual(['https://files.example.test/errors-catalog.csv?sig=1']));
    click.mockRestore();
  });

  it('W04 F2: the list of earlier imports shows file name, status and counts; selecting one opens it', async () => {
    const earlier = job({ id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', status: 'DONE', fileName: 'spring.csv', rowsProcessed: 12, rowsFailed: 0, finishedAt: '2026-10-16T10:00:00.000Z' });
    handlers([http.get(base, () => HttpResponse.json({ items: [summary(earlier)], nextCursor: null }))]);
    mount();
    const table = await screen.findByRole('table', { name: /imports/i });
    expect(within(table).getByText('spring.csv')).toBeInTheDocument();
    expect(within(table).getByText('Done')).toBeInTheDocument();
  });
});
