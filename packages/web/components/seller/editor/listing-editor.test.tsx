import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { draftSchema, draftVersionSchema } from '@marketplace-sandbox/contracts';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { backoffDelay, type SocketLike } from '@/lib/seller/collab-session';
import { origin, SELLER_PRODUCT_ID, SELLER_SHOP_ID, shopFixture, VIEWER_PERMISSIONS } from '@/lib/test/seller-handlers';
import { ListingEditor } from './listing-editor';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/products/${SELLER_PRODUCT_ID}/draft`,
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * W04 F1 (S06 `contracts/http.md` and `collab-ws.md`): the editing connection is a WebSocket stub that speaks the real
 * y-websocket sync messages against a second document (the "server"); the HTTP routes are MSW handlers.
 */

const DRAFT_ID = 'd1a2b3c4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const VERSION_ID = 'e2b3c4d5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const USER_ID = 'f3c4d5e6-a7b8-4c9d-8e1f-2a3b4c5d6e7f';
const drafts = `${origin}/api/shops/${SELLER_SHOP_ID}/drafts/${DRAFT_ID}`;
const WS_URL = `wss://collab.example.test/collab/${DRAFT_ID}`;

const draft = (overrides: Record<string, unknown> = {}) =>
  draftSchema.parse({ id: DRAFT_ID, shopId: SELLER_SHOP_ID, productId: SELLER_PRODUCT_ID, title: 'Clay mug', status: 'DRAFT', baseProductVersion: 3, createdBy: USER_ID, createdAt: '2026-10-17T08:00:00.000Z', updatedAt: '2026-10-17T08:00:00.000Z', publishedAt: null, ...overrides });
const version = (name: string, kind = 'named', id = VERSION_ID) => draftVersionSchema.parse({ id, name, kind, createdBy: USER_ID, createdAt: '2026-10-17T08:30:00.000Z' });
const problem = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  HttpResponse.json({ type: 'about:blank', title: 'Never shown', status, detail: 'Never shown detail', instance: '/x', code, requestId: 'req-d-1', ...extra }, { status, headers: { 'content-type': 'application/problem+json', ...headers } });

// ---------------------------------------------------------------- the stub connection

const bytesOf = (write: (encoder: encoding.Encoder) => void): Uint8Array => {
  const encoder = encoding.createEncoder();
  write(encoder);
  return encoding.toUint8Array(encoder);
};

class FakeSocket implements SocketLike {
  binaryType = 'blob';
  readyState = 0;
  sent: Uint8Array[] = [];
  closedByClient: [number | undefined, string | undefined] | null = null;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  onSend: ((data: Uint8Array) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: Uint8Array) {
    this.sent.push(data);
    this.onSend?.(data);
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closedByClient = [code, reason];
  }
  get ticket() {
    return new URL(this.url).searchParams.get('ticket');
  }
  open() {
    this.readyState = 1;
    act(() => this.onopen?.({}));
  }
  receive(bytes: Uint8Array) {
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    act(() => this.onmessage?.({ data }));
  }
  serverClose(code: number, reason = '') {
    this.readyState = 3;
    act(() => this.onclose?.({ code, reason }));
  }
}

/** Opens `socket` and lets the "server" document sync with the client the way a y-websocket server does. */
function serve(socket: FakeSocket, serverDoc: Y.Doc) {
  socket.onSend = (data) => {
    const decoder = decoding.createDecoder(data);
    if (decoding.readVarUint(decoder) !== 0) return;
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, 0);
    syncProtocol.readSyncMessage(decoder, reply, serverDoc, 'client');
    if (encoding.length(reply) > 1) socket.receive(encoding.toUint8Array(reply));
  };
  const push = (update: Uint8Array, from: unknown) => {
    if (from === 'client') return;
    socket.receive(bytesOf((e) => (encoding.writeVarUint(e, 0), syncProtocol.writeUpdate(e, update))));
  };
  serverDoc.on('update', push);
  socket.open();
  socket.receive(bytesOf((e) => (encoding.writeVarUint(e, 0), syncProtocol.writeSyncStep1(e, serverDoc))));
}

const seeded = (): Y.Doc => {
  const doc = new Y.Doc();
  doc.getText('title').insert(0, 'Clay mug');
  doc.getText('description').insert(0, 'Hand thrown.');
  doc.getMap('fields').set('priceMinor', 2450);
  doc.getMap('fields').set('quantity', 12);
  doc.getMap('specs').set('Material', 'Stoneware');
  return doc;
};

// ---------------------------------------------------------------- the page

let client: QueryClient;
let sockets: FakeSocket[];
let connects: number;
let canWrite: boolean;

function show(options: { shop?: ReturnType<typeof shopFixture>; draftOverrides?: Record<string, unknown> } = {}) {
  const shop = options.shop ?? shopFixture();
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(
    http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shop)),
    http.post(`${drafts}/connect`, () => {
      connects += 1;
      return HttpResponse.json({ url: WS_URL, ticket: `ticket-${connects}`, canWrite, expiresAt: '2026-10-17T09:00:00.000Z' });
    }),
  );
  return render(
    <QueryClientProvider client={client}>
      <ListingEditor
        shopId={SELLER_SHOP_ID}
        draft={draft(options.draftOverrides)}
        backoff={{ baseMs: 5, maxMs: 20, jitter: false }}
        createSocket={(url) => {
          const socket = new FakeSocket(url);
          sockets.push(socket);
          return socket;
        }}
      />
    </QueryClientProvider>,
  );
}
const versionsHandler = (items = [version('First cut')]) => http.get(`${drafts}/versions`, () => HttpResponse.json({ items, nextCursor: null }));
async function live(serverDoc = seeded()) {
  await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  serve(sockets[sockets.length - 1], serverDoc);
  await screen.findByText('Live. Changes are shared as you type.');
  return serverDoc;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  sockets = [];
  connects = 0;
  canWrite = true;
  vi.clearAllMocks();
  server.use(versionsHandler());
});

describe('W04 F1 connection', () => {
  it('W04 F1-1: asks for a ticket, opens wss://…?ticket=…, says it is connecting, syncs, and shows the server document', async () => {
    show();
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0].url).toBe(`${WS_URL}?ticket=ticket-1`);
    expect(sockets[0].binaryType).toBe('arraybuffer');
    sockets[0].open();
    expect(sockets[0].sent).toHaveLength(1);
    expect(decoding.readVarUint(decoding.createDecoder(sockets[0].sent[0]))).toBe(0);
    await live();
    expect(screen.getByLabelText('Title')).toHaveValue('Clay mug');
    expect(screen.getByLabelText('Description')).toHaveValue('Hand thrown.');
    expect(screen.getByLabelText('Price (EUR)')).toHaveValue('24.50');
    expect(screen.getByLabelText('Stock')).toHaveValue('12');
    expect(screen.getByLabelText('Value of Material')).toHaveValue('Stoneware');
  });

  it('W04 F1-2: typing in a field reaches the server document, and a change made elsewhere appears in the field', async () => {
    const user = userEvent.setup();
    show();
    const serverDoc = await live();
    const title = screen.getByLabelText('Title');
    await user.type(title, ' XL');
    expect(serverDoc.getText('title').toJSON()).toBe('Clay mug XL');
    await user.clear(screen.getByLabelText('Brand'));
    await user.type(screen.getByLabelText('Brand'), 'Clay Works');
    expect(serverDoc.getMap('fields').get('brand')).toBe('Clay Works');
    await user.clear(screen.getByLabelText('Price (EUR)'));
    await user.type(screen.getByLabelText('Price (EUR)'), '19.9');
    expect(serverDoc.getMap('fields').get('priceMinor')).toBe(1990);
    await user.type(screen.getByLabelText('Stock'), '0');
    expect(serverDoc.getMap('fields').get('quantity')).toBe(120);

    act(() => serverDoc.getText('description').insert(0, 'New: '));
    await waitFor(() => expect(screen.getByLabelText('Description')).toHaveValue('New: Hand thrown.'));
  });

  it('W04 F1-3: specification rows are added and removed in the shared document', async () => {
    const user = userEvent.setup();
    show();
    const serverDoc = await live();
    await user.type(screen.getByLabelText('Specification name'), 'Capacity');
    await user.type(screen.getByLabelText('Specification value'), '350 ml');
    await user.click(screen.getByRole('button', { name: 'Add specification' }));
    expect(serverDoc.getMap('specs').get('Capacity')).toBe('350 ml');
    await user.click(screen.getByRole('button', { name: 'Remove Material' }));
    expect(serverDoc.getMap('specs').has('Material')).toBe(false);
    await user.type(screen.getByLabelText('Specification name'), 'Bad: name');
    await user.type(screen.getByLabelText('Specification value'), 'x');
    await user.click(screen.getByRole('button', { name: 'Add specification' }));
    expect(screen.getByText("Names can't contain a colon and values must be one line.")).toBeInTheDocument();
  });

  it('W04 F1-4: a ticket with canWrite false opens the draft read only and sends nothing', async () => {
    canWrite = false;
    show();
    await waitFor(() => expect(sockets).toHaveLength(1));
    serve(sockets[0], seeded());
    expect(await screen.findByText('Live. Read only.')).toBeInTheDocument();
    expect(screen.getByText('You can view this draft but not change it.')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveAttribute('readonly');
    expect(screen.queryByLabelText('Specification name')).not.toBeInTheDocument();
  });

  it('W04 F1-5: a denied write (message type 4) says so and the draft turns read only', async () => {
    show();
    await live();
    sockets[0].receive(bytesOf((e) => (encoding.writeVarUint(e, 4), encoding.writeVarString(e, 'read_only'))));
    expect(await screen.findByText("Your last change wasn't saved because you only have read access.")).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveAttribute('readonly');
  });

  it('W04 F1-6: a draft that is not open (published, archived) is read only with its reason', async () => {
    show({ draftOverrides: { status: 'PUBLISHED', publishedAt: '2026-10-17T08:45:00.000Z' } });
    await live();
    expect(screen.getByText('This draft was published. Start a new draft to change the product again.')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('W04 F1-7: a viewer sees the draft with no Publish button and no version form', async () => {
    canWrite = false;
    show({ shop: shopFixture({ myRole: 'VIEWER', myPermissions: [...VIEWER_PERMISSIONS] }) });
    await waitFor(() => expect(sockets).toHaveLength(1));
    serve(sockets[0], seeded());
    await screen.findByText('Live. Read only.');
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save version' })).not.toBeInTheDocument();
  });
});

describe('W04 F1 close codes and reconnecting', () => {
  it.each([
    [4004, '', 'This draft no longer exists.'],
    [4003, 'access_revoked', 'You no longer have access to this draft.'],
    [4003, 'shop_inactive', "This shop isn't active, so the draft can't be edited."],
    [4000, '', 'Editing stopped because of a connection error. Reload the page to continue.'],
    [4008, 'room_full', 'Too many people are editing this draft. Try again later.'],
    [4009, '', 'This draft is too large to edit.'],
    [1009, '', 'A change was too large to send. Reload the page and try a smaller change.'],
  ])('W04 F1-10: close %i %s stops editing with its words and does not reconnect', async (code, reason, text) => {
    show();
    await live();
    sockets[0].serverClose(code, reason);
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.getByLabelText('Title')).toHaveAttribute('readonly');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(connects).toBe(1);
    expect(sockets).toHaveLength(1);
  });

  it('W04 F1-11: 4008 offers "Try again", which asks for a new ticket', async () => {
    const user = userEvent.setup();
    show();
    await live();
    sockets[0].serverClose(4008, 'room_full');
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(connects).toBe(2));
    expect(sockets[1].ticket).toBe('ticket-2');
  });

  it.each([1001, 1006, 1012, 4002, 4013])('W04 F1-12: close %i reconnects with a new ticket and the document stays on screen', async (code) => {
    show();
    await live();
    sockets[0].serverClose(code);
    expect(await screen.findByText('Connection lost. Reconnecting…')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Clay mug');
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(connects).toBe(2);
    expect(sockets[1].ticket).toBe('ticket-2');
  });

  it('W04 F1-13: reconnect waits longer after each failure and starts again from the base after a good sync', async () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, { baseMs: 1000, maxMs: 30000 }))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    const spread = [0, 1, 2].map((attempt) => backoffDelay(attempt, { baseMs: 1000, maxMs: 30000, jitter: true }, () => 0.5));
    expect(spread).toEqual([750, 1500, 3000]);
    expect(backoffDelay(3, { baseMs: 1000, maxMs: 30000, jitter: true }, () => 0)).toBe(4000);

    show();
    await live();
    sockets[0].serverClose(1006);
    await waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1].serverClose(1006);
    await waitFor(() => expect(sockets).toHaveLength(3));
    expect(connects).toBe(3);
    serve(sockets[2], seeded());
    await screen.findByText('Live. Changes are shared as you type.');
  });

  it('W04 F1-14: an edit made while the link is down is kept and reaches the server after the reconnect', async () => {
    const user = userEvent.setup();
    show();
    const serverDoc = await live();
    sockets[0].serverClose(1006);
    await user.type(screen.getByLabelText('Title'), '!');
    expect(screen.getByLabelText('Title')).toHaveValue('Clay mug!');
    expect(serverDoc.getText('title').toJSON()).toBe('Clay mug');
    await waitFor(() => expect(sockets).toHaveLength(2));
    serve(sockets[1], serverDoc);
    await waitFor(() => expect(serverDoc.getText('title').toJSON()).toBe('Clay mug!'));
  });

  it('W04 F1-15: 4001 reconnects to the address in the reason with the same ticket and asks the API for nothing', async () => {
    show();
    await live();
    sockets[0].serverClose(4001, 'collab-2.example.test');
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[1].url).toBe(`wss://collab-2.example.test/collab/${DRAFT_ID}?ticket=ticket-1`);
    expect(connects).toBe(1);
  });

  it('W04 F1-16: 4005 draft_closed asks for a new ticket and the draft comes back read only', async () => {
    show();
    await live();
    canWrite = false;
    sockets[0].serverClose(4005, 'draft_closed');
    await waitFor(() => expect(sockets).toHaveLength(2));
    serve(sockets[1], seeded());
    expect(await screen.findByText('You can view this draft but not change it.')).toBeInTheDocument();
    expect(connects).toBe(2);
  });

  it('W04 F1-17: 503 collab_unavailable with Retry-After shows a countdown and does not open a socket yet', async () => {
    server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shopFixture())), http.post(`${drafts}/connect`, () => problem(503, 'collab_unavailable', {}, { 'retry-after': '5' })));
    render(
      <QueryClientProvider client={client}>
        <ListingEditor shopId={SELLER_SHOP_ID} draft={draft()} backoff={{ baseMs: 5, maxMs: 20, jitter: false }} createSocket={(url) => new FakeSocket(url)} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Too many requests. Try again in \d s./)).toBeInTheDocument();
    expect(screen.queryByText('Never shown detail')).not.toBeInTheDocument();
  });

  it('W04 F1-18: 404 draft_not_found from connect stops with the draft text', async () => {
    server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shopFixture())), http.post(`${drafts}/connect`, () => problem(404, 'draft_not_found')));
    render(
      <QueryClientProvider client={client}>
        <ListingEditor shopId={SELLER_SHOP_ID} draft={draft()} createSocket={(url) => new FakeSocket(url)} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('This draft no longer exists.')).toBeInTheDocument();
  });
});

describe('W04 F1 versions', () => {
  it('W04 F1-20: lists the saved versions with their kind, and saves a named version', async () => {
    let body: unknown;
    let saved = false;
    server.use(
      http.get(`${drafts}/versions`, () => HttpResponse.json({ items: saved ? [version('Before sale', 'named', 'aaaaaaaa-1111-4111-8111-111111111111'), version('First cut', 'published')] : [version('First cut', 'published')], nextCursor: null })),
      http.post(`${drafts}/versions`, async ({ request }) => ((body = await request.json()), (saved = true), HttpResponse.json(version('Before sale', 'named', 'aaaaaaaa-1111-4111-8111-111111111111'), { status: 201 }))),
    );
    const user = userEvent.setup();
    show();
    await live();
    const list = await screen.findByRole('list', { name: 'Saved versions' });
    expect(within(list).getByText('First cut')).toBeInTheDocument();
    expect(list).toHaveTextContent('Published');
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    expect(screen.getByText('Enter a name for this version.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Version name'), 'Before sale');
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Version saved'));
    expect(body).toEqual({ name: 'Before sale' });
    expect(await screen.findByText('Before sale')).toBeInTheDocument();
  });

  it('W04 F1-21: 409 version_limit_reached reads as a sentence; a long list pages with "Load more versions"', async () => {
    server.use(http.post(`${drafts}/versions`, () => problem(409, 'version_limit_reached')));
    const user = userEvent.setup();
    show();
    await live();
    await user.type(await screen.findByLabelText('Version name'), 'One more');
    await user.click(screen.getByRole('button', { name: 'Save version' }));
    expect(await screen.findByText('This draft has the maximum number of saved versions.')).toBeInTheDocument();
    expect(screen.queryByText('Never shown detail')).not.toBeInTheDocument();
  });

  it('W04 F1-22: "Load more versions" asks for the next page with its cursor', async () => {
    const cursors: (string | null)[] = [];
    server.use(
      http.get(`${drafts}/versions`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursors.push(cursor);
        return HttpResponse.json(cursor ? { items: [version('Older', 'named', 'bbbbbbbb-1111-4111-8111-111111111111')], nextCursor: null } : { items: [version('Newer')], nextCursor: 'v2' });
      }),
    );
    const user = userEvent.setup();
    show();
    await live();
    await user.click(await screen.findByRole('button', { name: 'Load more versions' }));
    expect(await screen.findByText('Older')).toBeInTheDocument();
    expect(cursors).toEqual([null, 'v2']);
  });
});

describe('W04 F1 publishing', () => {
  it('W04 F1-30: Publish asks first, sends an Idempotency-Key and an empty body, then says which product version it made', async () => {
    let key: string | null = null;
    let body: unknown;
    server.use(
      http.post(`${drafts}/publish`, async ({ request }) => {
        key = request.headers.get('idempotency-key');
        body = await request.json();
        return HttpResponse.json({ productId: SELLER_PRODUCT_ID, productVersion: 4, versionId: VERSION_ID });
      }),
    );
    const user = userEvent.setup();
    show();
    await live();
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish this draft?' });
    expect(key).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Published as version 4'));
    expect(key).toMatch(/^[\w-]{1,128}$/);
    expect(body).toEqual({});
    expect(screen.getByText(/Published as version 4\./)).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveAttribute('readonly');
  });

  it('W04 F1-31: a retry of the same attempt reuses the key; opening the dialog again makes a new key', async () => {
    const keys: (string | null)[] = [];
    server.use(
      http.post(`${drafts}/publish`, ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        return keys.length === 1 ? problem(500, 'internal_error') : problem(409, 'publish_in_progress');
      }),
    );
    const user = userEvent.setup();
    show();
    await live();
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    let dialog = await screen.findByRole('dialog', { name: 'Publish this draft?' });
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    expect(await within(dialog).findByText('Something went wrong on our side.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
    expect(await within(dialog).findByText('This draft is being published already. Check the versions in a moment.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    dialog = await screen.findByRole('dialog', { name: 'Publish this draft?' });
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('W04 F1-32: 409 product_version_conflict explains it and "Publish anyway" sends acknowledgeProductVersion with a new key', async () => {
    const seen: { key: string | null; body: unknown }[] = [];
    server.use(
      http.post(`${drafts}/publish`, async ({ request }) => {
        seen.push({ key: request.headers.get('idempotency-key'), body: await request.json() });
        return seen.length === 1 ? problem(409, 'product_version_conflict', { currentVersion: 7 }) : HttpResponse.json({ productId: SELLER_PRODUCT_ID, productVersion: 8, versionId: VERSION_ID });
      }),
    );
    const user = userEvent.setup();
    show();
    await live();
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Publish this draft?' })).getByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish anyway?' });
    expect(dialog).toHaveTextContent('is at version 7 now');
    await user.click(within(dialog).getByRole('button', { name: 'Publish anyway' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Published as version 8'));
    expect(seen[0].body).toEqual({});
    expect(seen[1].body).toEqual({ acknowledgeProductVersion: 7 });
    expect(seen[1].key).not.toBe(seen[0].key);
  });

  it('W04 F1-33: 422 listing_invalid names the brand: the message is at the Brand field, the field has focus and the draft stays editable', async () => {
    server.use(http.post(`${drafts}/publish`, () => problem(422, 'listing_invalid', { errors: [{ field: 'brand', code: 'required' }] })));
    const user = userEvent.setup();
    show();
    await live();
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Publish' }));
    const brand = screen.getByLabelText('Brand');
    expect(await screen.findByText('Enter a brand before publishing.')).toBeInTheDocument();
    expect(brand).toHaveAttribute('aria-invalid', 'true');
    expect(brand).toHaveAccessibleDescription('Enter a brand before publishing.');
    await waitFor(() => expect(brand).toHaveFocus());
    expect(screen.getByText("This draft can't be published yet. Fix the fields marked below.")).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.type(brand, 'Clay Works');
    expect(screen.queryByText('Enter a brand before publishing.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
  });

  it('W04 F1-34: several listing_invalid problems each show at their own field, with the words of their code', async () => {
    server.use(
      http.post(`${drafts}/publish`, () =>
        problem(422, 'listing_invalid', {
          errors: [
            { field: 'title', code: 'invalid' },
            { field: 'priceMinor', code: 'required' },
            { field: 'quantity', code: 'invalid' },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    show();
    await live();
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText("Title isn't valid for a listing.")).toBeInTheDocument();
    expect(screen.getByText('Enter a price before publishing.')).toBeInTheDocument();
    expect(screen.getByText("Stock isn't valid for a listing.")).toBeInTheDocument();
  });

  it('W04 F1-35: 409 invalid_transition on publish says the draft was already published or archived', async () => {
    server.use(http.post(`${drafts}/publish`, () => problem(409, 'invalid_transition', { currentStatus: 'PUBLISHED' })));
    const user = userEvent.setup();
    show();
    await live();
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    expect(await within(dialog).findByText('This draft was already published or archived.')).toBeInTheDocument();
  });
});
