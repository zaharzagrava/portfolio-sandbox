import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { installClipboardStub } from '@/lib/test/clipboard-stub';
import { KEY_ID, keyFixture, SECRET_KEY } from '@/lib/test/seller-developers-fixtures';
import { origin, SELLER_SHOP_ID, sellerProblem, shopFixture } from '@/lib/test/seller-handlers';
import { ApiKeysView } from './api-keys-view';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const push = vi.fn();
const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/developers/api-keys`,
  useSearchParams: () => new URLSearchParams(search),
}));

const PATH = `/dashboard/seller/${SELLER_SHOP_ID}/developers/api-keys`;
const keys = `${origin}/api/shops/${SELLER_SHOP_ID}/developers/keys`;
const OTHER = '99999999-2222-4333-8444-555555555555';

let client: QueryClient;
function show(shop = shopFixture()) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shop)));
  return render(
    <QueryClientProvider client={client}>
      <ApiKeysView shopId={SELLER_SHOP_ID} serverParams={{}} apiBaseUrl="https://api.example.test/" />
    </QueryClientProvider>,
  );
}
const list = (items: ReturnType<typeof keyFixture>[], nextCursor: string | null = null) => http.get(keys, () => HttpResponse.json({ items, nextCursor }));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  search = '';
  vi.clearAllMocks();
  installClipboardStub('granted');
});

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string, item: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

describe('W04 API keys list', () => {
  it('W04 AS-44: the table lists prefix, mode, scopes, status and never-used keys, and never a secret', async () => {
    server.use(
      list([
        keyFixture(),
        keyFixture({ id: OTHER, name: 'Old live', livemode: true, status: 'rotating', expiresAt: '2026-10-20T10:00:00.000Z', lastUsedAt: '2026-10-16T08:30:00.000Z', scopes: ['orders:read', 'stock:write'] }),
        keyFixture({ id: '88888888-2222-4333-8444-555555555555', name: 'Revoked one', status: 'revoked' }),
        keyFixture({ id: '77777777-2222-4333-8444-555555555555', name: 'Expired one', status: 'expired', expiresAt: '2026-09-01T00:00:00.000Z' }),
      ]),
    );
    show();
    const table = await screen.findByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers).toEqual(expect.arrayContaining(['Name', 'Key', 'Scopes', 'Status', 'Expires', 'Last used', 'Created']));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('sk_test_abcdefghijkl…');
    expect(rows[0]).toHaveTextContent('Test');
    expect(rows[0]).toHaveTextContent('Active');
    expect(rows[0]).toHaveTextContent('Never');
    expect(rows[1]).toHaveTextContent('sk_live_abcdefghijkl…');
    expect(rows[1]).toHaveTextContent('Live');
    expect(rows[1]).toHaveTextContent(/Rotating until/);
    expect(rows[1]).toHaveTextContent('orders:read');
    expect(rows[2]).toHaveTextContent('Revoked');
    expect(rows[3]).toHaveTextContent('Expired');
    expect(table.textContent).not.toMatch(/sk_(test|live)_[0-9A-Za-z]{12}_/);
    expect(rows[0].querySelector('[data-dimmed]')).toBeNull();
    expect(rows[2].querySelector('[data-dimmed="true"]')).not.toBeNull();
    expect(rows[3].querySelector('[data-dimmed="true"]')).not.toBeNull();
    // Revoked and expired keys offer no actions.
    expect(within(rows[2]).queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
  });

  it('W04 AS-44: with no keys the table is replaced by the empty text', async () => {
    server.use(list([]));
    show();
    expect(await screen.findByText('No API keys yet. Create one to start calling the API.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('W04 AS-44: a cursor in the URL is sent and Next page carries the next cursor', async () => {
    search = 'cursor=c1';
    let seen: URL | undefined;
    server.use(http.get(keys, ({ request }) => ((seen = new URL(request.url)), HttpResponse.json({ items: [keyFixture()], nextCursor: 'c2' }))));
    show();
    expect(await screen.findByRole('link', { name: 'Next page' })).toHaveAttribute('href', `${PATH}?cursor=c2`);
    expect(screen.getByRole('link', { name: 'First page' })).toHaveAttribute('href', PATH);
    expect(seen?.searchParams.get('cursor')).toBe('c1');
  });

  it('W04 AS-55: "Using the API" shows the base URL, a curl example with a placeholder key and the documentation link', async () => {
    server.use(list([]));
    show();
    const section = await screen.findByRole('region', { name: 'Using the API' });
    expect(section).toHaveTextContent('curl https://api.example.test/v1/products -H "Authorization: Bearer sk_test_…"');
    expect(section).toHaveTextContent(/Test keys/);
    expect(within(section).getByRole('link', { name: 'API documentation' })).toHaveAttribute('href', '/developers/docs');
  });
});

describe('W04 creating a key', () => {
  it('W04 AS-48: name is required and counted, the last scope cannot be unchecked, expiry is limited, live mode is off', async () => {
    server.use(list([]));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create key' });
    expect(within(dialog).getByText('0/60')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Name'), '  CI  ');
    expect(within(dialog).getByText('6/60')).toBeInTheDocument();
    const group = within(dialog).getByRole('group', { name: 'Scopes' });
    const read = within(group).getByRole('checkbox', { name: 'products:read' });
    expect(read).toBeChecked();
    expect(read).toBeDisabled();
    expect(within(dialog).getByText('A key needs at least one scope.')).toBeInTheDocument();
    await user.click(within(group).getByRole('checkbox', { name: 'orders:read' }));
    expect(read).toBeEnabled();
    const expiry = within(dialog).getByLabelText(/Expires/);
    expect(expiry).toHaveAttribute('type', 'date');
    const min = expiry.getAttribute('min') ?? '';
    const max = expiry.getAttribute('max') ?? '';
    const days = (Date.parse(`${max}T00:00:00Z`) - Date.parse(`${min}T00:00:00Z`)) / 86_400_000;
    expect(days).toBe(364);
    expect(within(dialog).getByRole('switch', { name: 'Live mode' })).not.toBeChecked();
    expect(within(dialog).getByText('Live keys act on real data.')).toBeInTheDocument();
  });

  it('W04 AS-45 AS-46: Create key sends the trimmed form, shows the secret once, and after Done the list shows the new key by prefix', async () => {
    let body: unknown;
    let created = false;
    server.use(
      http.get(keys, () => HttpResponse.json({ items: created ? [keyFixture()] : [], nextCursor: null })),
      http.post(keys, async ({ request }) => {
        body = await request.json();
        created = true;
        return HttpResponse.json({ ...keyFixture(), key: SECRET_KEY }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create key' });
    await user.type(within(dialog).getByLabelText('Name'), '  CI pipeline ');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
    const reveal = await screen.findByRole('dialog', { name: 'Save your API key' });
    expect(body).toEqual({ name: 'CI pipeline', scopes: ['products:read'], livemode: false });
    expect(within(reveal).getByText(SECRET_KEY)).toBeInTheDocument();
    // The secret is in neither cache.
    expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(SECRET_KEY);
    await user.click(within(reveal).getByRole('button', { name: 'Copy' }));
    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('sk_test_abcdefghijkl…')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET_KEY);
  });

  it('W04 AS-49: mfa_required for a live key says so, links to two-step setup with the page as returnTo, and keeps the form', async () => {
    server.use(list([]), http.post(keys, () => sellerProblem('mfa_required')));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create key' });
    await user.type(within(dialog).getByLabelText('Name'), 'Live CI');
    await user.click(within(dialog).getByRole('switch', { name: 'Live mode' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(await within(dialog).findByText('Live keys need two-step verification.')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Set up or verify two-step' })).toHaveAttribute(
      'href',
      `/account/security?tab=two-step&returnTo=${encodeURIComponent(PATH)}`,
    );
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Live CI');
    expect(within(dialog).getByRole('switch', { name: 'Live mode' })).toBeChecked();
  });

  it('W04 AS-50: key_limit_reached explains the 25-key limit in the dialog', async () => {
    server.use(list([]), http.post(keys, () => sellerProblem('key_limit_reached')));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create key' });
    await user.type(within(dialog).getByLabelText('Name'), 'One more');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
    expect(await within(dialog).findByText('You have 25 active keys. Revoke one to create another.')).toBeInTheDocument();
  });

  it('W04 AS-48: a server validation_failed shows under its field and never the server title', async () => {
    server.use(list([]), http.post(keys, () => sellerProblem('validation_failed', { errors: [{ field: 'name', code: 'too_long' }] })));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Create key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create key' });
    await user.type(within(dialog).getByLabelText('Name'), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Create key' }));
    const name = within(dialog).getByLabelText('Name');
    await waitFor(() => expect(name).toHaveAccessibleDescription(/Check this field\./));
    expect(dialog).not.toHaveTextContent('Server title');
  });
});

describe('W04 rotating and revoking a key', () => {
  it('W04 AS-51: rotation offers the overlaps, sends the choice, reveals the new key with the old key end, and the list shows the successor', async () => {
    let body: unknown;
    let rotated = false;
    server.use(
      http.get(keys, () =>
        HttpResponse.json({
          items: rotated
            ? [keyFixture({ status: 'rotating', expiresAt: '2026-10-20T10:00:00.000Z' }), keyFixture({ id: OTHER, name: 'CI pipeline (rotated)' })]
            : [keyFixture()],
          nextCursor: null,
        }),
      ),
      http.post(`${keys}/${KEY_ID}/rotate`, async ({ request }) => {
        body = await request.json();
        rotated = true;
        return HttpResponse.json({ ...keyFixture({ id: OTHER, name: 'CI pipeline (rotated)' }), key: SECRET_KEY, previousExpiresAt: '2026-10-20T10:00:00.000Z' }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'CI pipeline', 'Rotate');
    const dialog = await screen.findByRole('dialog', { name: 'Rotate this key?' });
    const overlap = within(dialog).getByLabelText('Keep the old key working for');
    expect(within(overlap).getAllByRole('option').map((option) => option.textContent)).toEqual(['Expire immediately', '1 hour', '24 hours', '72 hours', '7 days']);
    expect(overlap).toHaveValue('24');
    await user.selectOptions(overlap, '72');
    await user.click(within(dialog).getByRole('button', { name: 'Rotate key' }));
    const reveal = await screen.findByRole('dialog', { name: 'Save your new API key' });
    expect(body).toEqual({ overlapHours: 72 });
    expect(within(reveal).getByText(SECRET_KEY)).toBeInTheDocument();
    expect(within(reveal).getByText(/The old key keeps working until/)).toBeInTheDocument();
    await user.click(within(reveal).getByRole('button', { name: 'Copy' }));
    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    expect(await screen.findByText(/Rotating until/)).toBeInTheDocument();
    expect(screen.getByText('CI pipeline (rotated)')).toBeInTheDocument();
  });

  it.each([
    ['key_revoked', 'This key is already revoked.'],
    ['key_expired', 'This key has expired.'],
    ['key_already_rotating', 'This key is already being rotated.'],
  ] as const)('W04 AS-52: %s says so in the dialog and the list is fetched again', async (code, message) => {
    let reads = 0;
    server.use(
      http.get(keys, () => (reads++, HttpResponse.json({ items: [keyFixture()], nextCursor: null }))),
      http.post(`${keys}/${KEY_ID}/rotate`, () => sellerProblem(code)),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'CI pipeline', 'Rotate');
    const dialog = await screen.findByRole('dialog', { name: 'Rotate this key?' });
    await user.click(within(dialog).getByRole('button', { name: 'Rotate key' }));
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });

  it('W04 AS-53: revoke starts on Cancel, a double press sends one request, the toast says "Key revoked" and the row is revoked without actions', async () => {
    let revoked = false;
    let deletes = 0;
    server.use(
      http.get(keys, () => HttpResponse.json({ items: [keyFixture({ status: revoked ? 'revoked' : 'active' }), keyFixture({ id: OTHER, name: 'Successor' })], nextCursor: null })),
      http.delete(`${keys}/${KEY_ID}`, () => ((revoked = true), deletes++, new HttpResponse(null, { status: 204 }))),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'CI pipeline', 'Revoke');
    const dialog = await screen.findByRole('dialog', { name: 'Revoke this key?' });
    expect(dialog).toHaveTextContent("Every request with this key will be refused right away. This can't be undone.");
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus());
    const confirm = within(dialog).getByRole('button', { name: 'Revoke key' });
    await user.dblClick(confirm);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Key revoked'));
    expect(deletes).toBe(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    await waitFor(() => expect(rows[0]).toHaveTextContent('Revoked'));
    await waitFor(() => expect(within(screen.getAllByRole('row')[1]).queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument());
    // The successor's row is untouched.
    expect(within(screen.getAllByRole('row')[2]).getByRole('button', { name: 'Actions for Successor' })).toBeInTheDocument();
  });

  it('W04 AS-54: a viewer who lacks shop.manage sees no create button or row actions', async () => {
    server.use(list([keyFixture()]));
    show(shopFixture({ myRole: 'VIEWER', myPermissions: ['shop.read'] }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create key' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
  });
});
