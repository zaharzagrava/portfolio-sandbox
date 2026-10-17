import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { installClipboardStub } from '@/lib/test/clipboard-stub';
import { productMemberFixture } from '@/lib/test/seller-inventory-fixtures';
import { origin, SELLER_PRODUCT_ID, SELLER_SHOP_ID, shopFixture, VIEWER_PERMISSIONS } from '@/lib/test/seller-handlers';
import { WidgetView } from './widget-view';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/widget`,
  useSearchParams: () => new URLSearchParams(''),
}));

const shopApi = `${origin}/api/shops/${SELLER_SHOP_ID}`;
const sites = `${shopApi}/widget/sites`;
const SITE_ID = '5a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const SECRET = `wis_${'Q'.repeat(43)}`;
const SECRET_2 = `wis_${'R'.repeat(43)}`;

const siteFixture = (over: Record<string, unknown> = {}) => ({
  id: SITE_ID,
  shopId: SELLER_SHOP_ID,
  name: 'Blog widget',
  publishableKey: 'pk_live_abcdefghijklmnopqrstuvwx',
  allowedOrigins: ['https://blog.example.com'],
  featuredProductIds: [],
  theme: {},
  killSwitch: false,
  hasPreviousSecret: false,
  previousSecretExpiresAt: null,
  version: 3,
  createdAt: '2026-10-10T09:00:00.000Z',
  updatedAt: '2026-10-11T09:00:00.000Z',
  ...over,
});
const list = (items: unknown[], nextCursor: string | null = null) => http.get(sites, () => HttpResponse.json({ items, nextCursor }));
const problem = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  HttpResponse.json(
    { type: `https://marketplace.example/problems/${code}`, title: 'Server title never shown', status, detail: 'Server detail never shown', instance: '/t', code, requestId: 'req-widget-1', ...extra },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
const inventory = () => http.get(`${shopApi}/products`, () => HttpResponse.json({ items: [productMemberFixture({ title: 'Blue mug' })], nextCursor: null }));

let client: QueryClient;
function show(shop = shopFixture()) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(http.get(shopApi, () => HttpResponse.json(shop)), inventory());
  return render(
    <QueryClientProvider client={client}>
      <WidgetView shopId={SELLER_SHOP_ID} />
    </QueryClientProvider>,
  );
}
async function openMenu(user: ReturnType<typeof userEvent.setup>, item: string, name = 'Blog widget') {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  vi.clearAllMocks();
  installClipboardStub('granted');
});

describe('W04 storefront widget sites', () => {
  it('W04 F8: sites list with name, public key, origins and Live or Off', async () => {
    server.use(
      list([
        siteFixture({ allowedOrigins: ['https://a.example.com', 'https://b.example.com', 'https://c.example.com'] }),
        siteFixture({ id: '6a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d', name: 'Shop page', killSwitch: true }),
      ]),
    );
    show();
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Blog widget');
    expect(rows[0]).toHaveTextContent('pk_live_abcdefghijklmnopqrstuvwx');
    expect(rows[0]).toHaveTextContent('https://a.example.com');
    expect(rows[0]).toHaveTextContent('+2 more');
    expect(rows[0]).toHaveTextContent('Live');
    expect(rows[1]).toHaveTextContent('Off');
  });

  it('W04 F8: an empty list says so', async () => {
    server.use(list([]));
    show();
    expect(await screen.findByText('No widget sites yet.')).toBeInTheDocument();
  });

  it('W04 F8: a member without widget.manage gets the access panel and no site request', async () => {
    let asked = 0;
    server.use(http.get(sites, () => (asked++, HttpResponse.json({ items: [], nextCursor: null }))));
    show(shopFixture({ myRole: 'VIEWER', myPermissions: [...VIEWER_PERMISSIONS] }));
    expect(await screen.findByText("You don't have access to this page.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add site' })).not.toBeInTheDocument();
    expect(asked).toBe(0);
  });

  it('W04 F8: a suspended shop disables Add site and the change actions', async () => {
    server.use(list([siteFixture()]));
    show(shopFixture({ status: 'SUSPENDED' }));
    expect(await screen.findByRole('button', { name: 'Add site' })).toBeDisabled();
  });

  it('W04 F8: a failed read shows words and Try again, never the server text', async () => {
    server.use(http.get(sites, () => problem(503, 'service_unavailable')));
    show();
    expect(await screen.findByRole('button', { name: 'Try again' }, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText(/Server title|Server detail/)).not.toBeInTheDocument();
  });
});

describe('W04 storefront widget create', () => {
  async function openAdd(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Add site' }));
    return screen.findByRole('dialog', { name: 'Add site' });
  }

  it('W04 F8: creates with name, origins and featured products; the secret shows once in the reveal dialog', async () => {
    let body: unknown;
    let created = false;
    server.use(
      http.get(sites, () => HttpResponse.json({ items: created ? [siteFixture({ version: 1 })] : [], nextCursor: null })),
      http.post(sites, async ({ request }) => ((body = await request.json()), (created = true), HttpResponse.json({ ...siteFixture({ version: 1 }), identitySecret: SECRET }, { status: 201 }))),
    );
    const user = userEvent.setup();
    const { container } = show();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Blog widget');
    await user.type(within(dialog).getByLabelText('Allowed origins'), 'https://blog.example.com{enter}https://www.blog.example.com');
    await user.click(await within(dialog).findByRole('checkbox', { name: 'Blue mug' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add site' }));

    await waitFor(() => expect(body).toEqual({ name: 'Blog widget', origins: ['https://blog.example.com', 'https://www.blog.example.com'], featuredProductIds: [SELLER_PRODUCT_ID] }));
    const reveal = await screen.findByRole('dialog', { name: 'Widget identity secret' });
    expect(within(reveal).getByText(SECRET)).toBeInTheDocument();
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(SECRET);
    expect(JSON.stringify(client.getMutationCache().getAll().map((mutation) => mutation.state.data))).not.toContain(SECRET);

    await user.click(within(reveal).getByRole('button', { name: /Copy/ }));
    await user.click(within(reveal).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(container.ownerDocument.body.textContent).not.toContain(SECRET));
    expect(await screen.findByRole('table')).toHaveTextContent('Blog widget');
  });

  it('W04 F8: origin_invalid names the address and the reason, and keeps the form', async () => {
    server.use(list([]), http.post(sites, () => problem(422, 'origin_invalid', { details: { origin: 'http://blog.example.com', reason: 'not_https' } })));
    const user = userEvent.setup();
    show();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Allowed origins'), 'http://blog.example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Add site' }));
    expect(await within(dialog).findByText('http://blog.example.com: must start with https://')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Allowed origins')).toHaveValue('http://blog.example.com');
    expect(screen.queryByText(/Server title|Server detail/)).not.toBeInTheDocument();
  });

  it.each([
    [422, 'featured_product_invalid', 'One of the featured products is not available in this shop.'],
    [422, 'site_limit_reached', 'You have the maximum number of widget sites.'],
  ])('W04 F8: %s %s is shown in words', async (status, code, text) => {
    server.use(list([]), http.post(sites, () => problem(status, code)));
    const user = userEvent.setup();
    show();
    const dialog = await openAdd(user);
    await user.type(within(dialog).getByLabelText('Allowed origins'), 'https://blog.example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Add site' }));
    expect(await within(dialog).findByText(new RegExp(text))).toBeInTheDocument();
  });

  it('W04 F8: at least one origin is needed before anything is sent', async () => {
    let posted = false;
    server.use(list([]), http.post(sites, () => ((posted = true), problem(400, 'validation_failed'))));
    const user = userEvent.setup();
    show();
    const dialog = await openAdd(user);
    await user.click(within(dialog).getByRole('button', { name: 'Add site' }));
    expect(await within(dialog).findByText('Add at least one address.')).toBeInTheDocument();
    expect(posted).toBe(false);
  });
});

describe('W04 storefront widget edit', () => {
  it('W04 F8: PATCH carries only the changed fields and expectedVersion', async () => {
    let body: unknown;
    server.use(list([siteFixture()]), http.patch(`${sites}/${SITE_ID}`, async ({ request }) => ((body = await request.json()), HttpResponse.json(siteFixture({ version: 4, allowedOrigins: ['https://blog.example.com', 'https://new.example.com'] })))));
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit site' });
    const field = within(dialog).getByLabelText('Allowed origins');
    expect(field).toHaveValue('https://blog.example.com');
    await user.type(field, '{enter}https://new.example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(body).toEqual({ allowedOrigins: ['https://blog.example.com', 'https://new.example.com'], expectedVersion: 3 }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit site' })).not.toBeInTheDocument());
  });

  it('W04 F8: Save changes stays disabled until something changed', async () => {
    server.use(list([siteFixture()]));
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit site' });
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('W04 F8: site_version_conflict says so; Load latest brings the current values and the new version', async () => {
    let body: unknown;
    let current = siteFixture();
    server.use(
      http.get(sites, () => HttpResponse.json({ items: [current], nextCursor: null })),
      http.patch(`${sites}/${SITE_ID}`, async ({ request }) => {
        const sent = (await request.json()) as { expectedVersion: number };
        if (sent.expectedVersion === 3) {
          current = siteFixture({ version: 4, name: 'Renamed elsewhere' });
          return problem(409, 'site_version_conflict');
        }
        body = sent;
        return HttpResponse.json(siteFixture({ version: 5 }));
      }),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit site' });
    await user.type(within(dialog).getByLabelText('Allowed origins'), '{enter}https://new.example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByText('This site changed since you opened it.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Load latest' }));
    await waitFor(() => expect(within(dialog).getByLabelText('Name')).toHaveValue('Renamed elsewhere'));
    await user.type(within(dialog).getByLabelText('Allowed origins'), '{enter}https://new.example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(body).toMatchObject({ expectedVersion: 4 }));
  });

  it('W04 F8: origin_invalid on edit names the address', async () => {
    server.use(list([siteFixture()]), http.patch(`${sites}/${SITE_ID}`, () => problem(422, 'origin_invalid', { details: { origin: '*.example.com', reason: 'wildcard' } })));
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Edit');
    const dialog = await screen.findByRole('dialog', { name: 'Edit site' });
    await user.type(within(dialog).getByLabelText('Allowed origins'), '{enter}*.example.com');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByText('*.example.com: wildcards are not allowed')).toBeInTheDocument();
  });
});

describe('W04 storefront widget kill switch, secret and delete', () => {
  it('W04 F8: Turn off widget asks first, sends PUT {on: true}, and the row shows Off with the new version', async () => {
    let body: unknown;
    let current = siteFixture();
    server.use(
      http.get(sites, () => HttpResponse.json({ items: [current], nextCursor: null })),
      http.put(`${sites}/${SITE_ID}/kill-switch`, async ({ request }) => ((body = await request.json()), (current = siteFixture({ killSwitch: true, version: 4 })), HttpResponse.json(current))),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Turn off widget');
    const dialog = await screen.findByRole('dialog', { name: 'Turn off this widget?' });
    expect(body).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Turn off widget' }));
    await waitFor(() => expect(body).toEqual({ on: true }));
    await waitFor(() => expect(within(screen.getByRole('table')).getAllByRole('row')[1]).toHaveTextContent('Off'));
  });

  it('W04 F8: Turn on widget needs no question and sends PUT {on: false}', async () => {
    let body: unknown;
    server.use(list([siteFixture({ killSwitch: true })]), http.put(`${sites}/${SITE_ID}/kill-switch`, async ({ request }) => ((body = await request.json()), HttpResponse.json(siteFixture({ version: 4 })))));
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Turn on widget');
    await waitFor(() => expect(body).toEqual({ on: false }));
  });

  it('W04 F8: Rotate identity secret posts the overlap and shows the new secret once, with the old one’s end', async () => {
    let body: unknown;
    server.use(
      list([siteFixture()]),
      http.post(`${sites}/${SITE_ID}/rotate-secret`, async ({ request }) => ((body = await request.json()), HttpResponse.json({ identitySecret: SECRET_2, previousSecretExpiresAt: '2026-10-20T10:00:00.000Z' }, { status: 201 }))),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Rotate identity secret');
    const confirm = await screen.findByRole('dialog', { name: 'Rotate the identity secret?' });
    await user.click(within(confirm).getByRole('button', { name: 'Rotate secret' }));
    await waitFor(() => expect(body).toEqual({ overlapHours: 24 }));
    const reveal = await screen.findByRole('dialog', { name: 'Widget identity secret' });
    expect(within(reveal).getByText(SECRET_2)).toBeInTheDocument();
    expect(reveal).toHaveTextContent('The old secret stays valid until');
    expect(JSON.stringify(client.getMutationCache().getAll().map((mutation) => mutation.state.data))).not.toContain(SECRET_2);
  });

  it('W04 F8: rotation_in_progress offers End old secret now, which posts expire-previous-secret', async () => {
    let expired = 0;
    server.use(
      list([siteFixture({ hasPreviousSecret: true, previousSecretExpiresAt: '2026-10-20T10:00:00.000Z' })]),
      http.post(`${sites}/${SITE_ID}/rotate-secret`, () => problem(409, 'rotation_in_progress')),
      http.post(`${sites}/${SITE_ID}/expire-previous-secret`, () => (expired++, HttpResponse.json(siteFixture({ version: 4 })))),
    );
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Rotate identity secret');
    const confirm = await screen.findByRole('dialog', { name: 'Rotate the identity secret?' });
    await user.click(within(confirm).getByRole('button', { name: 'Rotate secret' }));
    expect(await within(confirm).findByText('A previous secret is still valid. End it first or wait.')).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'End old secret now' }));
    const ask = await screen.findByRole('dialog', { name: 'End the old secret now?' });
    await user.click(within(ask).getByRole('button', { name: 'End old secret now' }));
    await waitFor(() => expect(expired).toBe(1));
  });

  it('W04 F8: Delete asks, then sends DELETE and refreshes', async () => {
    let deleted = 0;
    server.use(list([siteFixture()]), http.delete(`${sites}/${SITE_ID}`, () => (deleted++, new HttpResponse(null, { status: 204 }))));
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete this site?' });
    expect(deleted).toBe(0);
    await user.click(within(dialog).getByRole('button', { name: 'Delete site' }));
    await waitFor(() => expect(deleted).toBe(1));
  });

  it('W04 F8: a refused change (widget_site_not_found) is shown in words', async () => {
    server.use(list([siteFixture({ killSwitch: true })]), http.put(`${sites}/${SITE_ID}/kill-switch`, () => problem(404, 'widget_site_not_found')));
    const user = userEvent.setup();
    show();
    await openMenu(user, 'Turn on widget');
    expect(await screen.findByText('This site was already deleted.')).toBeInTheDocument();
  });
});
