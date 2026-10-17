import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createHash } from 'node:crypto';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { productMemberFixture } from '@/lib/test/seller-inventory-fixtures';
import { origin, SELLER_PRODUCT_ID, SELLER_SHOP_ID, shopFixture, VIEWER_PERMISSIONS } from '@/lib/test/seller-handlers';
import { DocumentsView } from './documents-view';

const push = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/knowledge`,
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PATH = `/dashboard/seller/${SELLER_SHOP_ID}/knowledge`;
const shopApi = `${origin}/api/shops/${SELLER_SHOP_ID}`;
const docs = `${shopApi}/knowledge/documents`;
const DOC_ID = '4a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const UPLOAD_URL = 'https://storage.example.com/bucket/object?signature=abc';

const document = (over: Record<string, unknown> = {}) => ({
  id: DOC_ID,
  title: 'Returns policy',
  visibility: 'SHOP_PRIVATE',
  productId: null,
  format: 'MARKDOWN',
  status: 'READY',
  failureCode: null,
  chunkCount: 6,
  createdAt: '2026-10-10T09:00:00.000Z',
  updatedAt: '2026-10-11T09:00:00.000Z',
  ...over,
});
const page = (items: unknown[], nextCursor: string | null = null) => http.get(docs, () => HttpResponse.json({ items, nextCursor }));
const problem = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  HttpResponse.json(
    { type: `https://marketplace.example/problems/${code}`, title: 'Server title never shown', status, detail: 'Server detail never shown', instance: '/t', code, requestId: 'req-kb-1', ...extra },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
const inventory = () => http.get(`${shopApi}/products`, () => HttpResponse.json({ items: [productMemberFixture({ title: 'Blue mug' })], nextCursor: null }));

let client: QueryClient;
function show(shop = shopFixture(), pollMs = 40) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(http.get(shopApi, () => HttpResponse.json(shop)), inventory());
  return render(
    <QueryClientProvider client={client}>
      <DocumentsView shopId={SELLER_SHOP_ID} pollMs={pollMs} />
    </QueryClientProvider>,
  );
}
async function openMenu(user: ReturnType<typeof userEvent.setup>, item: string, name = 'Returns policy') {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  search = '';
  vi.clearAllMocks();
});

describe('W04 knowledge documents list', () => {
  it('W04 F9: title, visibility, status, chunks; a failed document names the reason in words', async () => {
    server.use(
      page([
        document(),
        document({ id: '3a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', title: 'Scanned manual', visibility: 'PUBLIC', format: 'PDF', status: 'FAILED', failureCode: 'no_text', chunkCount: 0, productId: SELLER_PRODUCT_ID }),
        document({ id: '2a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', title: 'Half sent', format: 'PDF', status: 'AWAITING_UPLOAD', chunkCount: 0 }),
      ]),
    );
    show();
    const table = await screen.findByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Title', 'Visibility', 'Status', 'Chunks']));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Returns policy');
    expect(rows[0]).toHaveTextContent('Private to this shop');
    expect(rows[0]).toHaveTextContent('Ready');
    expect(rows[1]).toHaveTextContent('Public');
    expect(rows[1]).toHaveTextContent('Failed');
    expect(rows[1]).toHaveTextContent("The file has no text we can read.");
    expect(rows[2]).toHaveTextContent('Waiting for the file');
  });

  it('W04 F9: the status filter is in the URL and the call carries it', async () => {
    const seen: string[] = [];
    server.use(http.get(docs, ({ request }) => (seen.push(new URL(request.url).search), HttpResponse.json({ items: [], nextCursor: null }))));
    const user = userEvent.setup();
    show();
    await user.selectOptions(await screen.findByLabelText('Status'), 'FAILED');
    expect(push).toHaveBeenCalledWith(`${PATH}?status=FAILED`);
    search = 'status=FAILED';
    show();
    expect(await screen.findAllByText('No documents match this status.')).not.toHaveLength(0);
    expect(seen.some((query) => query.includes('status=FAILED'))).toBe(true);
  });

  it('W04 F9: Next page carries the cursor; an empty library says so', async () => {
    search = 'cursor=c1';
    server.use(http.get(docs, ({ request }) => (expect(new URL(request.url).searchParams.get('cursor')).toBe('c1'), HttpResponse.json({ items: [document()], nextCursor: 'c2' }))));
    show();
    expect(await screen.findByRole('link', { name: 'Next page' })).toHaveAttribute('href', `${PATH}?cursor=c2`);
    expect(screen.getByRole('link', { name: 'First page' })).toHaveAttribute('href', PATH);
  });

  it('W04 F9: no documents yet', async () => {
    server.use(page([]));
    show();
    expect(await screen.findByText('No documents yet.')).toBeInTheDocument();
  });

  it('W04 F9: a failed read shows words and Try again, never the server text', async () => {
    server.use(http.get(docs, () => problem(503, 'service_unavailable')));
    show();
    expect(await screen.findByRole('button', { name: 'Try again' }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(/Server title|Server detail/)).not.toBeInTheDocument();
  });

  it('W04 F9: a document being indexed is polled until it is ready, then polling stops', async () => {
    let reads = 0;
    server.use(
      http.get(docs, () => {
        reads++;
        return HttpResponse.json({ items: [document({ status: reads < 3 ? 'PROCESSING' : 'READY', chunkCount: reads < 3 ? 0 : 6 })], nextCursor: null });
      }),
    );
    show();
    const row = async () => within(await screen.findByRole('table')).getAllByRole('row')[1];
    expect(await row()).toHaveTextContent('Processing');
    await waitFor(async () => expect(await row()).toHaveTextContent('Ready'), { timeout: 3000 });
    const settled = reads;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reads).toBe(settled);
  });
});

describe('W04 knowledge documents permissions', () => {
  it('W04 F9: without products.write the list shows but there is no Add, Retry or Delete', async () => {
    server.use(page([document({ status: 'FAILED', failureCode: 'unparseable' })]));
    show(shopFixture({ myRole: 'VIEWER', myPermissions: [...VIEWER_PERMISSIONS] }));
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Add document' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();
  });

  it('W04 F9: a suspended shop disables Add document but Ask still works', async () => {
    server.use(page([document()]));
    show(shopFixture({ status: 'SUSPENDED' }));
    expect(await screen.findByRole('button', { name: 'Add document' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ask' })).toBeEnabled();
  });
});

describe('W04 knowledge documents create', () => {
  async function openAdd(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Add document' }));
    return screen.findByRole('dialog', { name: 'Add document' });
  }

  it('W04 F9: markdown goes inline; the list refreshes and the dialog closes', async () => {
    let body: unknown;
    let created = false;
    server.use(
      http.get(docs, () => HttpResponse.json({ items: created ? [document({ title: 'FAQ', status: 'QUEUED', chunkCount: 0 })] : [], nextCursor: null })),
      http.post(docs, async ({ request }) => ((body = await request.json()), (created = true), HttpResponse.json({ document: document({ title: 'FAQ', status: 'QUEUED' }), deduplicated: false }, { status: 201 }))),
    );
    const user = userEvent.setup();
    show();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Title'), 'FAQ');
    await user.click(within(dialog).getByText('Pasted text'));
    await user.type(within(dialog).getByLabelText('Markdown'), '# Shipping');
    await user.click(within(dialog).getByRole('button', { name: 'Add document' }));
    await waitFor(() => expect(body).toEqual({ title: 'FAQ', visibility: 'SHOP_PRIVATE', markdown: '# Shipping' }));
    expect(await screen.findByRole('table')).toHaveTextContent('FAQ');
    expect(screen.queryByRole('dialog', { name: 'Add document' })).not.toBeInTheDocument();
  });

  it('W04 F9: a document about a product is sent as public with its productId', async () => {
    let body: unknown;
    server.use(page([]), http.post(docs, async ({ request }) => ((body = await request.json()), HttpResponse.json({ document: document({ status: 'QUEUED' }), deduplicated: false }, { status: 201 }))));
    const user = userEvent.setup();
    show();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Title'), 'Mug care');
    await within(dialog).findByRole('option', { name: 'Blue mug' });
    await user.selectOptions(within(dialog).getByLabelText('Product (optional)'), SELLER_PRODUCT_ID);
    expect(within(dialog).getByLabelText('Visibility')).toHaveValue('PUBLIC');
    await user.click(within(dialog).getByText('Pasted text'));
    await user.type(within(dialog).getByLabelText('Markdown'), 'Hand wash only.');
    await user.click(within(dialog).getByRole('button', { name: 'Add document' }));
    await waitFor(() => expect(body).toEqual({ title: 'Mug care', visibility: 'PUBLIC', productId: SELLER_PRODUCT_ID, markdown: 'Hand wash only.' }));
  });

  it('W04 F9: a PDF is announced by hash and size, sent to the presigned URL without cookies, then marked uploaded', async () => {
    const content = '%PDF-1.4 manual';
    const file = new File([content], 'manual.pdf', { type: 'application/pdf' });
    const hash = createHash('sha256').update(content).digest('hex');
    const order: string[] = [];
    let announced: unknown;
    let putHeaders: Record<string, string> = {};
    server.use(
      page([]),
      http.post(docs, async ({ request }) => {
        order.push('create');
        announced = await request.json();
        return HttpResponse.json({ document: document({ format: 'PDF', status: 'AWAITING_UPLOAD', chunkCount: 0 }), deduplicated: false, upload: { url: UPLOAD_URL, headers: { 'content-type': 'application/pdf', 'x-amz-meta-sha': hash }, expiresAt: '2026-10-17T10:00:00.000Z' } }, { status: 201 });
      }),
      http.put(UPLOAD_URL, ({ request }) => {
        order.push('put');
        putHeaders = Object.fromEntries(request.headers.entries());
        return new HttpResponse(null, { status: 200 });
      }),
      http.post(`${docs}/${DOC_ID}/uploaded`, () => (order.push('uploaded'), HttpResponse.json(document({ format: 'PDF', status: 'QUEUED', chunkCount: 0 })))),
    );
    const user = userEvent.setup();
    show();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Title'), 'Manual');
    await user.click(within(dialog).getByText('Upload a PDF'));
    await user.upload(within(dialog).getByLabelText('PDF file', { selector: 'input' }), file);
    await user.click(within(dialog).getByRole('button', { name: 'Add document' }));
    await waitFor(() => expect(order).toEqual(['create', 'put', 'uploaded']));
    expect(announced).toEqual({ title: 'Manual', visibility: 'SHOP_PRIVATE', pdfSha256: hash, pdfSize: content.length });
    expect(putHeaders['x-amz-meta-sha']).toBe(hash);
    expect(putHeaders['x-csrf-token'] ?? putHeaders.authorization ?? putHeaders.cookie).toBeUndefined();
  });

  it('W04 F9: a failed upload says so and does not call uploaded', async () => {
    let uploaded = 0;
    server.use(
      page([]),
      http.post(docs, () => HttpResponse.json({ document: document({ status: 'AWAITING_UPLOAD', format: 'PDF' }), deduplicated: false, upload: { url: UPLOAD_URL, headers: {}, expiresAt: '2026-10-17T10:00:00.000Z' } }, { status: 201 })),
      http.put(UPLOAD_URL, () => new HttpResponse(null, { status: 403 })),
      http.post(`${docs}/${DOC_ID}/uploaded`, () => (uploaded++, HttpResponse.json(document()))),
    );
    const user = userEvent.setup();
    show();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Title'), 'Manual');
    await user.click(within(dialog).getByText('Upload a PDF'));
    await user.upload(within(dialog).getByLabelText('PDF file', { selector: 'input' }), new File(['%PDF'], 'm.pdf', { type: 'application/pdf' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add document' }));
    expect(await within(dialog).findByText("The file didn't upload. Choose it and try again.")).toBeInTheDocument();
    expect(uploaded).toBe(0);
  });

  it('W04 F9: a file that is not a PDF is refused by the form', async () => {
    let posted = false;
    server.use(page([]), http.post(docs, () => ((posted = true), problem(400, 'validation_failed'))));
    const user = userEvent.setup({ applyAccept: false });
    show();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Title'), 'Notes');
    await user.click(within(dialog).getByText('Upload a PDF'));
    await user.upload(within(dialog).getByLabelText('PDF file', { selector: 'input' }), new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add document' }));
    expect(await within(dialog).findByText('Choose a PDF file up to 20 MB.')).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  it('W04 F9: an identical document answers 200 deduplicated and says it is already there', async () => {
    server.use(page([document()]), http.post(docs, () => HttpResponse.json({ document: document(), deduplicated: true }, { status: 200 })));
    const user = userEvent.setup();
    show();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Title'), 'Returns policy');
    await user.click(within(dialog).getByText('Pasted text'));
    await user.type(within(dialog).getByLabelText('Markdown'), 'Same text');
    await user.click(within(dialog).getByRole('button', { name: 'Add document' }));
    const { toast } = await import('sonner');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('This document is already in your library.'));
  });

  it.each([
    [422, 'document_limit_reached', 'You have the maximum number of documents.'],
    [422, 'product_document_must_be_public', 'A document about a product must be public.'],
    [404, 'not_found', 'This document no longer exists.'],
    [409, 'product_archived', 'This product was archived or restored elsewhere.'],
    [400, 'validation_failed', 'Check the details and try again.'],
  ])('W04 F9: %s %s is shown in words, the dialog stays open', async (status, code, text) => {
    server.use(page([]), http.post(docs, () => problem(status, code)));
    const user = userEvent.setup();
    show();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Title'), 'FAQ');
    await user.click(within(dialog).getByText('Pasted text'));
    await user.type(within(dialog).getByLabelText('Markdown'), 'text');
    await user.click(within(dialog).getByRole('button', { name: 'Add document' }));
    expect(await within(dialog).findByText(new RegExp(text))).toBeInTheDocument();
    expect(screen.queryByText(/Server title|Server detail/)).not.toBeInTheDocument();
  });

  it('W04 F9: upload_missing after the upload is shown in words', async () => {
    server.use(
      page([]),
      http.post(docs, () => HttpResponse.json({ document: document({ status: 'AWAITING_UPLOAD', format: 'PDF' }), deduplicated: false, upload: { url: UPLOAD_URL, headers: {}, expiresAt: '2026-10-17T10:00:00.000Z' } }, { status: 201 })),
      http.put(UPLOAD_URL, () => new HttpResponse(null, { status: 200 })),
      http.post(`${docs}/${DOC_ID}/uploaded`, () => problem(409, 'upload_missing')),
    );
    const user = userEvent.setup();
    show();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Title'), 'Manual');
    await user.click(within(dialog).getByText('Upload a PDF'));
    await user.upload(within(dialog).getByLabelText('PDF file', { selector: 'input' }), new File(['%PDF'], 'm.pdf', { type: 'application/pdf' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add document' }));
    expect(await within(dialog).findByText(/The file hasn't arrived yet/)).toBeInTheDocument();
  });
});

describe('W04 knowledge documents retry and delete', () => {
  it('W04 F9: Retry is offered for a failed document only, posts retry, and the row is queued', async () => {
    let hit = 0;
    let current = document({ status: 'FAILED', failureCode: 'embedding_unavailable', chunkCount: 0 });
    server.use(
      http.get(docs, () => HttpResponse.json({ items: [current], nextCursor: null })),
      http.post(`${docs}/${DOC_ID}/retry`, () => (hit++, (current = document({ status: 'QUEUED', chunkCount: 0 })), HttpResponse.json(current, { status: 202 }))),
    );
    const user = userEvent.setup();
    show(shopFixture(), 100_000);
    await openMenu(user, 'Retry');
    await waitFor(() => expect(hit).toBe(1));
    await waitFor(() => expect(within(screen.getByRole('table')).getAllByRole('row')[1]).toHaveTextContent('Queued'));
  });

  it('W04 F9: a ready document has no Retry', async () => {
    server.use(page([document()]));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Actions for Returns policy' }));
    expect(screen.queryByRole('menuitem', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('W04 F9: invalid_transition on retry is shown in words and the list is refetched', async () => {
    let reads = 0;
    server.use(
      http.get(docs, () => (reads++, HttpResponse.json({ items: [document({ status: 'FAILED', failureCode: 'unparseable' })], nextCursor: null }))),
      http.post(`${docs}/${DOC_ID}/retry`, () => problem(409, 'invalid_transition')),
    );
    const user = userEvent.setup();
    show(shopFixture(), 100_000);
    await openMenu(user, 'Retry');
    expect(await screen.findByText(/This document can't be changed in its current state/)).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });

  it('W04 F9: Delete asks first, then sends DELETE', async () => {
    let deleted = 0;
    server.use(page([document()]), http.delete(`${docs}/${DOC_ID}`, () => (deleted++, new HttpResponse(null, { status: 204 }))));
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete this document?' });
    expect(deleted).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete document' }));
    await waitFor(() => expect(deleted).toBe(1));
  });

  it('W04 F9: deleting a document that is already gone (404) closes the dialog and refetches', async () => {
    let reads = 0;
    server.use(
      http.get(docs, () => (reads++, HttpResponse.json({ items: reads > 1 ? [] : [document()], nextCursor: null }))),
      http.delete(`${docs}/${DOC_ID}`, () => problem(404, 'not_found')),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete this document?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete document' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete this document?' })).not.toBeInTheDocument());
    expect(await screen.findByText('No documents yet.')).toBeInTheDocument();
  });
});

describe('W04 knowledge help-center ask', () => {
  const encoder = new TextEncoder();
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const sse = (...frames: string[]) =>
    new HttpResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of frames) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  const askUrl = `${shopApi}/knowledge/ask`;

  async function ask(user: ReturnType<typeof userEvent.setup>, question = 'How do I list a product?') {
    await user.type(await screen.findByLabelText('Your question'), question);
    await user.click(screen.getByRole('button', { name: 'Ask' }));
  }

  it('W04 F9: posts the question, streams the answer text and lists the sources', async () => {
    let body: unknown;
    server.use(
      page([]),
      http.post(askUrl, async ({ request }) => {
        body = await request.json();
        return sse(
          frame('sources', { mode: 'hybrid', items: [{ n: 0, chunkId: 'c0', documentId: DOC_ID, title: 'Seller guide', headingPath: 'Listing > Products', page: null }] }),
          frame('text', { t: 'Open Inventory ' }),
          frame('text', { t: 'and choose Add product.' }),
          frame('done', { citations: [{ text: 'Open Inventory and choose Add product.', sources: [0] }], grounded: true }),
        );
      }),
    );
    const user = userEvent.setup();
    show();
    await ask(user);
    expect(await screen.findByText('Open Inventory and choose Add product.')).toBeInTheDocument();
    expect(body).toEqual({ question: 'How do I list a product?' });
    expect(screen.getByText(/Seller guide/)).toBeInTheDocument();
  });

  it('W04 F9: not_found says no answer was found; refusal and error have their own lines', async () => {
    server.use(page([]), http.post(askUrl, () => sse(frame('not_found', { message: 'x' }))));
    const user = userEvent.setup();
    show();
    await ask(user);
    expect(await screen.findByText(/couldn't find an answer/)).toBeInTheDocument();
  });

  it('W04 F9: an in-stream error ends the answer in words', async () => {
    server.use(page([]), http.post(askUrl, () => sse(frame('error', { code: 'TIMEOUT' }))));
    const user = userEvent.setup();
    show();
    await ask(user);
    expect(await screen.findByText("The answer couldn't be completed. Try again.")).toBeInTheDocument();
  });

  it('W04 F9: a question under 3 characters is not sent', async () => {
    let asked = 0;
    server.use(page([]), http.post(askUrl, () => (asked++, sse())));
    const user = userEvent.setup();
    show();
    await ask(user, 'hi');
    expect(await screen.findByText('Ask with at least 3 characters.')).toBeInTheDocument();
    expect(asked).toBe(0);
  });

  it.each([
    [429, 'assistant_busy', /Too many requests|assistant is busy/],
    [503, 'assistant_unavailable', /That didn't work|couldn't load/],
    [422, 'input_rejected', /can't be answered here/],
  ])('W04 F9: a refusal before the stream (%s %s) is shown in words', async (status, code, text) => {
    server.use(page([]), http.post(askUrl, () => problem(status, code, {}, status === 429 ? { 'retry-after': '5' } : {})));
    const user = userEvent.setup();
    show();
    await ask(user);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText(/Server title|Server detail/)).not.toBeInTheDocument();
  });
});
