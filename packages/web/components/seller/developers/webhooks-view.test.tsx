import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { installClipboardStub } from '@/lib/test/clipboard-stub';
import { ENDPOINT_ID, endpointFixture, eventTypesFixture, SECRET_HOOK, versionFixture } from '@/lib/test/seller-developers-fixtures';
import { origin, SELLER_SHOP_ID, sellerProblem, shopFixture } from '@/lib/test/seller-handlers';
import { WebhooksView } from './webhooks-view';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const push = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/developers/webhooks`,
  useSearchParams: () => new URLSearchParams(search),
}));

const dev = `${origin}/api/shops/${SELLER_SHOP_ID}/developers`;
const hooks = `${dev}/webhooks`;
const URL_OK = 'https://example.com/new';

let client: QueryClient;
function show(shop = shopFixture()) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(
    http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shop)),
    http.get(`${dev}/api-version`, () => HttpResponse.json(versionFixture())),
  );
  return render(
    <QueryClientProvider client={client}>
      <WebhooksView shopId={SELLER_SHOP_ID} serverParams={{}} />
    </QueryClientProvider>,
  );
}
const list = (items: ReturnType<typeof endpointFixture>[], nextCursor: string | null = null) => http.get(hooks, () => HttpResponse.json({ items, nextCursor }));
const catalogue = () => http.get(`${dev}/webhook-event-types`, () => HttpResponse.json(eventTypesFixture()));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  search = '';
  vi.clearAllMocks();
  installClipboardStub('granted');
});

async function openMenu(user: ReturnType<typeof userEvent.setup>, item: string, name = URL_LABEL) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}
const URL_LABEL = 'https://example.com/hooks/marketplace';

async function openAdd(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Add endpoint' }));
  return screen.findByRole('dialog', { name: 'Add endpoint' });
}

describe('W04 webhook endpoint list', () => {
  it('W04 AS-56: columns, full URL, three events and "+n more", version and status badges', async () => {
    server.use(
      list([
        endpointFixture({ events: ['order.paid', 'order.cancelled', 'product.updated', 'product.created', 'payout.paid'] }),
        endpointFixture({ id: 'b0e1f2a3-4c5d-4e6f-8a9b-0c1d2e3f4a5b', url: 'https://x.test/a', status: 'disabled', disabledReason: 'manual' }),
        endpointFixture({ id: 'c0e1f2a3-4c5d-4e6f-8a9b-0c1d2e3f4a5b', url: 'https://x.test/b', status: 'disabled', disabledReason: 'auto_failing', failingSince: '2026-10-10T10:00:00.000Z' }),
        endpointFixture({ id: 'd0e1f2a3-4c5d-4e6f-8a9b-0c1d2e3f4a5b', url: 'https://x.test/c', breaker: 'open', hasPreviousSecret: true, previousSecretExpiresAt: '2026-10-20T10:00:00.000Z' }),
      ]),
    );
    show();
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(expect.arrayContaining(['URL', 'Events', 'API version', 'Status', 'Created']));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent(URL_LABEL);
    expect(rows[0]).toHaveTextContent('order.paid');
    expect(rows[0]).toHaveTextContent('product.updated');
    expect(rows[0]).not.toHaveTextContent('product.created');
    expect(rows[0]).toHaveTextContent('+2 more');
    expect(rows[0]).toHaveTextContent('2026-01-15');
    expect(rows[0]).toHaveTextContent('Enabled');
    expect(rows[1]).toHaveTextContent('Disabled (paused by you)');
    expect(rows[2]).toHaveTextContent(/Disabled automatically after repeated failures \(since /);
    expect(rows[3]).toHaveTextContent('Retrying after failures');
    expect(rows[3]).toHaveTextContent(/Old secret valid until /);
    expect(within(rows[0]).getByRole('link', { name: URL_LABEL })).toHaveAttribute('href', `/dashboard/seller/${SELLER_SHOP_ID}/developers/webhooks/${ENDPOINT_ID}`);
  });

  it('W04 AS-56: with no endpoints the empty text shows', async () => {
    server.use(list([]));
    show();
    expect(await screen.findByText('No webhook endpoints yet. Add one to receive events.')).toBeInTheDocument();
  });
});

describe('W04 adding and editing an endpoint', () => {
  it('W04 AS-57 AS-58: choices come from the catalogue grouped by resource, the version defaults to the pin, and the secret is revealed once', async () => {
    let body: unknown;
    let added = false;
    server.use(
      http.get(hooks, () => HttpResponse.json({ items: added ? [endpointFixture({ url: URL_OK })] : [], nextCursor: null })),
      catalogue(),
      http.post(hooks, async ({ request }) => {
        body = await request.json();
        added = true;
        return HttpResponse.json({ ...endpointFixture({ url: URL_OK }), secret: SECRET_HOOK }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    show();
    const dialog = await openAdd(user);
    const orderGroup = await within(dialog).findByRole('group', { name: 'Orders' });
    expect(within(orderGroup).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(dialog).getByRole('group', { name: 'Products' })).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText('API version')).toHaveValue('2026-01-15'));
    await user.type(within(dialog).getByLabelText('Endpoint URL'), URL_OK);
    await user.click(within(dialog).getByRole('checkbox', { name: /order\.paid/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add endpoint' }));
    const reveal = await screen.findByRole('dialog', { name: 'Webhook signing secret' });
    expect(body).toEqual({ url: URL_OK, events: ['order.paid'], apiVersion: '2026-01-15' });
    expect(within(reveal).getByText(SECRET_HOOK)).toBeInTheDocument();
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(SECRET_HOOK);
    await user.click(within(reveal).getByRole('button', { name: 'Copy' }));
    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('link', { name: URL_OK })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET_HOOK);
  });

  it('W04 AS-58: at least one event stays selected, and an event type the app never saw still shows by its name when editing', async () => {
    server.use(list([endpointFixture({ events: ['order.paid', 'payout.failed'] })]), catalogue());
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit endpoint' });
    expect(await within(dialog).findByRole('checkbox', { name: /payout\.failed/ })).toBeChecked();
    await user.click(within(dialog).getByRole('checkbox', { name: /payout\.failed/ }));
    expect(within(dialog).getByRole('checkbox', { name: /order\.paid/ })).toBeDisabled();
  });

  it('W04 AS-58: an unavailable catalogue shows the problem with Try again and keeps Add endpoint disabled', async () => {
    server.use(list([]), http.get(`${dev}/webhook-event-types`, () => sellerProblem('upstream_unavailable')));
    const user = userEvent.setup();
    show();
    const dialog = await openAdd(user);
    expect(await within(dialog).findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Endpoint URL'), URL_OK);
    expect(within(dialog).getByRole('button', { name: 'Add endpoint' })).toBeDisabled();
  });

  it.each([
    ['endpoint_url_rejected', 'The address resolves to a private network.', 'The address resolves to a private network.'],
    ['duplicate_endpoint_url', undefined, 'You already have an endpoint with this URL.'],
  ] as const)('W04 AS-59: %s is explained under the URL and the values are kept', async (code, detail, message) => {
    server.use(list([]), catalogue(), http.post(hooks, () => sellerProblem(code, detail ? { detail } : {})));
    const user = userEvent.setup();
    show();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Endpoint URL'), URL_OK);
    await user.click(await within(dialog).findByRole('checkbox', { name: /order\.paid/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add endpoint' }));
    await waitFor(() => expect(within(dialog).getByLabelText('Endpoint URL')).toHaveAccessibleDescription(message));
    expect(within(dialog).getByLabelText('Endpoint URL')).toHaveValue(URL_OK);
  });

  it('W04 AS-59: a rejected URL never shows the server title, and endpoint_limit_reached is an alert', async () => {
    server.use(list([]), catalogue(), http.post(hooks, () => sellerProblem('endpoint_limit_reached')));
    const user = userEvent.setup();
    show();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Endpoint URL'), URL_OK);
    await user.click(await within(dialog).findByRole('checkbox', { name: /order\.paid/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Add endpoint' }));
    expect(await within(dialog).findByText('You have 20 endpoints, the maximum. Delete one to add another.')).toBeInTheDocument();
  });

  it('W04 AS-60: editing sends only the changed fields, toasts "Endpoint updated" and closes', async () => {
    let body: unknown;
    server.use(
      list([endpointFixture()]),
      catalogue(),
      http.patch(`${hooks}/${ENDPOINT_ID}`, async ({ request }) => ((body = await request.json()), HttpResponse.json(endpointFixture({ url: 'https://example.com/changed' })))),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit endpoint' });
    const save = within(dialog).getByRole('button', { name: 'Save changes' });
    await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: /order\.paid/ })).toBeChecked());
    expect(save).toBeDisabled();
    const url = within(dialog).getByLabelText('Endpoint URL');
    await user.clear(url);
    await user.type(url, 'https://example.com/changed');
    await user.click(save);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Endpoint updated'));
    expect(body).toEqual({ url: 'https://example.com/changed' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('W04 endpoint actions', () => {
  it('W04 AS-61: Disable sends at once; an auto-disabled endpoint asks before Enable, which clears the failure history', async () => {
    let state = endpointFixture({ status: 'disabled', disabledReason: 'auto_failing', failingSince: '2026-10-10T10:00:00.000Z' });
    let enables = 0;
    server.use(
      http.get(hooks, () => HttpResponse.json({ items: [state], nextCursor: null })),
      http.post(`${hooks}/${ENDPOINT_ID}/enable`, () => ((enables += 1), (state = endpointFixture()), HttpResponse.json(state))),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Enable');
    const dialog = await screen.findByRole('dialog', { name: 'Enable this endpoint?' });
    expect(dialog).toHaveTextContent('Enabling clears the failure history and starts deliveries again.');
    expect(enables).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'Enable endpoint' }));
    await waitFor(() => expect(screen.getByRole('table')).toHaveTextContent('Enabled'));
    expect(enables).toBe(1);
  });

  it('W04 AS-61: Disable on an enabled endpoint becomes "Disabled (paused by you)"', async () => {
    let state = endpointFixture();
    server.use(
      http.get(hooks, () => HttpResponse.json({ items: [state], nextCursor: null })),
      http.post(`${hooks}/${ENDPOINT_ID}/disable`, () => ((state = endpointFixture({ status: 'disabled', disabledReason: 'manual' })), HttpResponse.json(state))),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Disable');
    await waitFor(() => expect(screen.getByRole('table')).toHaveTextContent('Disabled (paused by you)'));
  });

  it('W04 AS-61: endpoint_state_conflict shows the refreshed message and refetches; an enable rejected by URL is an alert', async () => {
    let reads = 0;
    server.use(
      http.get(hooks, () => (reads++, HttpResponse.json({ items: [endpointFixture()], nextCursor: null }))),
      http.post(`${hooks}/${ENDPOINT_ID}/disable`, () => sellerProblem('endpoint_state_conflict')),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Disable');
    expect(await screen.findByText('The endpoint was changed elsewhere. The list has been refreshed.')).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });

  it('W04 AS-62: Rotate secret offers 1/24/48/72 hours, reveals the secret once, and the old secret can be ended early', async () => {
    let body: unknown;
    let expired = 0;
    let rotated = false;
    server.use(
      http.get(hooks, () =>
        HttpResponse.json({ items: [endpointFixture(rotated ? { hasPreviousSecret: true, previousSecretExpiresAt: '2026-10-18T10:00:00.000Z' } : {})], nextCursor: null }),
      ),
      http.post(`${hooks}/${ENDPOINT_ID}/rotate-secret`, async ({ request }) => {
        body = await request.json();
        rotated = true;
        return HttpResponse.json({ secret: SECRET_HOOK, previousSecretExpiresAt: '2026-10-18T10:00:00.000Z' });
      }),
      http.post(`${hooks}/${ENDPOINT_ID}/expire-previous-secret`, () => ((expired += 1), HttpResponse.json(endpointFixture()))),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Rotate secret');
    const dialog = await screen.findByRole('dialog', { name: 'Rotate the signing secret?' });
    const overlap = within(dialog).getByLabelText('Keep the old secret valid for');
    expect(within(overlap).getAllByRole('option').map((option) => option.textContent)).toEqual(['1 hour', '24 hours', '48 hours', '72 hours']);
    expect(overlap).toHaveValue('24');
    await user.selectOptions(overlap, '48');
    await user.click(within(dialog).getByRole('button', { name: 'Rotate secret' }));
    const reveal = await screen.findByRole('dialog', { name: 'Webhook signing secret' });
    expect(body).toEqual({ overlapHours: 48 });
    expect(within(reveal).getByText(SECRET_HOOK)).toBeInTheDocument();
    expect(within(reveal).getByText(/The old secret stays valid until/)).toBeInTheDocument();
    await user.click(within(reveal).getByRole('button', { name: 'Copy' }));
    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    expect(await screen.findByText(/Old secret valid until/)).toBeInTheDocument();
    await openMenu(user, 'End old secret now');
    const confirm = await screen.findByRole('dialog', { name: 'End the old secret now?' });
    await user.click(within(confirm).getByRole('button', { name: 'End old secret now' }));
    await waitFor(() => expect(expired).toBe(1));
  });

  it('W04 AS-62: rotation_in_progress offers "End old secret now" in the dialog; no_previous_secret refetches without a message', async () => {
    let reads = 0;
    server.use(
      http.get(hooks, () => (reads++, HttpResponse.json({ items: [endpointFixture()], nextCursor: null }))),
      http.post(`${hooks}/${ENDPOINT_ID}/rotate-secret`, () => sellerProblem('rotation_in_progress')),
      http.post(`${hooks}/${ENDPOINT_ID}/expire-previous-secret`, () => sellerProblem('no_previous_secret')),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Rotate secret');
    const dialog = await screen.findByRole('dialog', { name: 'Rotate the signing secret?' });
    await user.click(within(dialog).getByRole('button', { name: 'Rotate secret' }));
    expect(await within(dialog).findByText('A previous secret is still valid. End it first or wait.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'End old secret now' }));
    const confirm = await screen.findByRole('dialog', { name: 'End the old secret now?' });
    const before = reads;
    await user.click(within(confirm).getByRole('button', { name: 'End old secret now' }));
    await waitFor(() => expect(reads).toBeGreaterThan(before));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('W04 AS-63: Delete asks, removes the row and toasts; a 404 removes it with "This endpoint was already deleted."', async () => {
    let gone = false;
    server.use(
      http.get(hooks, () => HttpResponse.json({ items: gone ? [] : [endpointFixture()], nextCursor: null })),
      http.delete(`${hooks}/${ENDPOINT_ID}`, () => ((gone = true), new HttpResponse(null, { status: 204 }))),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete this endpoint?' });
    expect(dialog).toHaveTextContent('Pending deliveries are cancelled.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete endpoint' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Endpoint deleted'));
    await waitFor(() => expect(screen.queryByRole('link', { name: URL_LABEL })).not.toBeInTheDocument());
  });

  it('W04 AS-63: an endpoint that is already gone is removed with its message', async () => {
    let gone = false;
    server.use(
      http.get(hooks, () => HttpResponse.json({ items: gone ? [] : [endpointFixture()], nextCursor: null })),
      http.delete(`${hooks}/${ENDPOINT_ID}`, () => ((gone = true), sellerProblem('webhook_endpoint_not_found'))),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete this endpoint?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete endpoint' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('This endpoint was already deleted.'));
    await waitFor(() => expect(screen.queryByRole('link', { name: URL_LABEL })).not.toBeInTheDocument());
  });

  it('W04 AS-64: Send test event toasts "Test event queued"; a 429 shows the countdown', async () => {
    let calls = 0;
    server.use(
      list([endpointFixture()]),
      http.post(`${hooks}/${ENDPOINT_ID}/ping`, () =>
        ++calls === 1 ? HttpResponse.json({ deliveryId: 'd', eventId: 'evt_x', endpointId: ENDPOINT_ID, state: 'queued' }, { status: 202 }) : sellerProblem('rate_limited', { retryAfter: 7 }),
      ),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Send test event');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Test event queued'));
    await openMenu(user, 'Send test event');
    expect(await screen.findByText(/Too many test events\. Try again in \d+ s\./)).toBeInTheDocument();
  });

  it('W04 AS-54: a member without webhooks.manage cannot add or change endpoints', async () => {
    server.use(list([endpointFixture()]));
    show(shopFixture({ myRole: 'ADMIN', myPermissions: ['shop.read'] }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add endpoint' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
  });
});
