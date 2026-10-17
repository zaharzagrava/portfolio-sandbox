import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { readWebhookAttemptsParams } from '@/lib/seller/search-params';
import { attemptFixture, ENDPOINT_ID, endpointFixture, EVENT_ID, eventDetailFixture } from '@/lib/test/seller-developers-fixtures';
import { origin, SELLER_SHOP_ID, sellerProblem, shopFixture } from '@/lib/test/seller-handlers';
import { WebhookDetailView } from './webhook-detail-view';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const push = vi.fn();
const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/developers/webhooks/${ENDPOINT_ID}`,
  useSearchParams: () => new URLSearchParams(search),
}));

const PATH = `/dashboard/seller/${SELLER_SHOP_ID}/developers/webhooks/${ENDPOINT_ID}`;
const hook = `${origin}/api/shops/${SELLER_SHOP_ID}/developers/webhooks/${ENDPOINT_ID}`;

let client: QueryClient;
function show(endpoint = endpointFixture()) {
  const shop = shopFixture();
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shop)), http.get(hook, () => HttpResponse.json(endpoint)));
  return render(
    <QueryClientProvider client={client}>
      <WebhookDetailView shopId={SELLER_SHOP_ID} endpointId={ENDPOINT_ID} serverParams={readWebhookAttemptsParams(Object.fromEntries(new URLSearchParams(search)))} />
    </QueryClientProvider>,
  );
}
const attempts = (items: ReturnType<typeof attemptFixture>[], nextCursor: string | null = null) => http.get(`${hook}/attempts`, () => HttpResponse.json({ items, nextCursor }));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  search = '';
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe('W04 webhook deliveries', () => {
  it('W04 AS-65: the summary and a table with Time, Event, Attempt, Result, Duration, Replay, newest first, with the response snippet as text', async () => {
    server.use(
      attempts([
        attemptFixture({ attemptId: 'a2', attempt: 2, status: 500, ok: false, responseSnippet: '<script>alert(1)</script>', replay: true }),
        attemptFixture({ attemptId: 'a1', attempt: 1, status: null, ok: false, error: 'timeout', durationMs: 5000 }),
      ]),
    );
    show();
    expect(await screen.findByRole('heading', { name: 'https://example.com/hooks/marketplace' })).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(expect.arrayContaining(['Time', 'Event', 'Attempt', 'Result', 'Duration', 'Replay']));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('order.paid');
    expect(rows[0]).toHaveTextContent('500');
    expect(rows[0]).toHaveTextContent('<script>alert(1)</script>');
    expect(rows[0].querySelector('script')).toBeNull();
    expect(rows[0]).toHaveTextContent('Replay');
    expect(rows[1]).toHaveTextContent('timeout');
    expect(rows[1]).toHaveTextContent('5000 ms');
  });

  it('W04 AS-65: "Failed only" writes ok=false to the URL and drops the cursor; the filter and cursor from the URL are sent', async () => {
    search = 'ok=false&cursor=c1';
    let seen: URL | undefined;
    server.use(http.get(`${hook}/attempts`, ({ request }) => ((seen = new URL(request.url)), HttpResponse.json({ items: [attemptFixture({ ok: false, status: 500 })], nextCursor: 'c2' }))));
    const user = userEvent.setup();
    show();
    const filter = await screen.findByRole('checkbox', { name: 'Failed only' });
    expect(filter).toBeChecked();
    expect(seen?.searchParams.get('ok')).toBe('false');
    expect(seen?.searchParams.get('cursor')).toBe('c1');
    expect(screen.getByRole('link', { name: 'Next page' })).toHaveAttribute('href', `${PATH}?ok=false&cursor=c2`);
    await user.click(filter);
    expect(push).toHaveBeenCalledWith(PATH);
  });

  it('W04 AS-65: with no deliveries the empty text shows', async () => {
    server.use(attempts([]));
    show();
    expect(await screen.findByText('No deliveries in the last 30 days.')).toBeInTheDocument();
  });

  it('W04 AS-64: Send test event toasts and the log refetches every 5 s for 30 s, then stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let pinged = false;
    let reads = 0;
    server.use(
      http.get(`${hook}/attempts`, () => (reads++, HttpResponse.json({ items: pinged ? [attemptFixture({ type: 'webhook.ping' })] : [], nextCursor: null }))),
      http.post(`${hook}/ping`, () => ((pinged = true), HttpResponse.json({ deliveryId: 'd', eventId: EVENT_ID, endpointId: ENDPOINT_ID, state: 'queued' }, { status: 202 }))),
    );
    show();
    await screen.findByText('No deliveries in the last 30 days.');
    await user.click(screen.getByRole('button', { name: 'Send test event' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Test event queued'));
    await act(() => vi.advanceTimersByTimeAsync(5_500));
    expect(await screen.findByText('webhook.ping')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    const settled = reads;
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(reads).toBe(settled);
  });

  it('W04 AS-64: a 429 on the test event shows the countdown and disables the button', async () => {
    server.use(attempts([]), http.post(`${hook}/ping`, () => sellerProblem('rate_limited', { retryAfter: 9 })));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Send test event' }));
    expect(await screen.findByText(/Too many test events\. Try again in \d+ s\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send test event' })).toBeDisabled();
  });
});

describe('W04 event panel and replay', () => {
  const rowWithEvent = () => attempts([attemptFixture()]);

  it('W04 AS-66: View event writes the event to the URL', async () => {
    server.use(rowWithEvent());
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: `View event ${EVENT_ID}` }));
    expect(replace).toHaveBeenCalledWith(`${PATH}?event=${EVENT_ID}`);
  });

  it('W04 AS-66: the panel shows id, type, time, state, attempts and the body as formatted text, never as HTML', async () => {
    search = `event=${EVENT_ID}`;
    server.use(rowWithEvent(), http.get(`${hook}/events/${EVENT_ID}`, () => HttpResponse.json(eventDetailFixture())));
    show();
    const panel = await screen.findByRole('dialog', { name: 'Event details' });
    await within(panel).findByText('delivered');
    expect(panel).toHaveTextContent(EVENT_ID);
    expect(panel).toHaveTextContent('order.paid');
    const pre = panel.querySelector('pre');
    expect(pre?.textContent).toContain('"note": "<b>bold</b>"');
    expect(panel.querySelector('b')).toBeNull();
  });

  it('W04 AS-66: an event older than 30 days says so', async () => {
    search = `event=${EVENT_ID}`;
    server.use(rowWithEvent(), http.get(`${hook}/events/${EVENT_ID}`, () => sellerProblem('webhook_event_not_found')));
    show();
    expect(await screen.findByText('This event is older than 30 days or no longer available.')).toBeInTheDocument();
  });

  it('W04 AS-67: Replay confirms, sends one Idempotency-Key that a retry reuses, then toasts "Replay queued"', async () => {
    search = `event=${EVENT_ID}`;
    const keys: (string | null)[] = [];
    server.use(
      rowWithEvent(),
      http.get(`${hook}/events/${EVENT_ID}`, () => HttpResponse.json(eventDetailFixture())),
      http.post(`${hook}/events/${EVENT_ID}/replay`, ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        return keys.length === 1 ? sellerProblem('idempotency_in_flight') : HttpResponse.json({ deliveryId: 'd', eventId: EVENT_ID, endpointId: ENDPOINT_ID, state: 'queued' }, { status: 202 });
      }),
    );
    const user = userEvent.setup();
    show();
    const panel = await screen.findByRole('dialog', { name: 'Event details' });
    await user.click(await within(panel).findByRole('button', { name: 'Replay' }));
    const confirm = await screen.findByRole('dialog', { name: 'Replay this event?' });
    expect(confirm).toHaveTextContent('The same body is sent again, signed now.');
    await user.click(within(confirm).getByRole('button', { name: 'Replay event' }));
    expect(await within(confirm).findByText('This replay is already being processed.')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Replay event' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Replay queued'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('W04 AS-67: a disabled endpoint and a rate limit are explained in the confirmation', async () => {
    search = `event=${EVENT_ID}`;
    let calls = 0;
    server.use(
      rowWithEvent(),
      http.get(`${hook}/events/${EVENT_ID}`, () => HttpResponse.json(eventDetailFixture())),
      http.post(`${hook}/events/${EVENT_ID}/replay`, () => (++calls === 1 ? sellerProblem('endpoint_disabled') : sellerProblem('rate_limited', { retryAfter: 4 }))),
    );
    const user = userEvent.setup();
    show();
    const panel = await screen.findByRole('dialog', { name: 'Event details' });
    await user.click(await within(panel).findByRole('button', { name: 'Replay' }));
    const confirm = await screen.findByRole('dialog', { name: 'Replay this event?' });
    await user.click(within(confirm).getByRole('button', { name: 'Replay event' }));
    expect(await within(confirm).findByText('Enable the endpoint first.')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Replay event' }));
    expect(await within(confirm).findByText(/Too many requests\. Try again in \d+ s\./)).toBeInTheDocument();
  });

  it('W04 AS-67: a different event gets a different Idempotency-Key', async () => {
    const other = 'evt_' + 'b2'.repeat(16);
    const keys: Record<string, string | null> = {};
    server.use(
      attempts([attemptFixture(), attemptFixture({ attemptId: 'a9', eventId: other })]),
      http.get(`${hook}/events/${EVENT_ID}`, () => HttpResponse.json(eventDetailFixture())),
      http.get(`${hook}/events/${other}`, () => HttpResponse.json(eventDetailFixture({ eventId: other }))),
      http.post(`${hook}/events/:id/replay`, ({ request, params }) => {
        keys[String(params.id)] = request.headers.get('idempotency-key');
        return HttpResponse.json({ deliveryId: 'd', eventId: String(params.id), endpointId: ENDPOINT_ID, state: 'queued' }, { status: 202 });
      }),
    );
    const user = userEvent.setup();
    for (const id of [EVENT_ID, other]) {
      search = `event=${id}`;
      const view = show();
      const panel = await screen.findByRole('dialog', { name: 'Event details' });
      await user.click(await within(panel).findByRole('button', { name: 'Replay' }));
      const confirm = await screen.findByRole('dialog', { name: 'Replay this event?' });
      await user.click(within(confirm).getByRole('button', { name: 'Replay event' }));
      await waitFor(() => expect(keys[id]).toBeTruthy());
      view.unmount();
    }
    expect(keys[EVENT_ID]).not.toBe(keys[other]);
  });
});
