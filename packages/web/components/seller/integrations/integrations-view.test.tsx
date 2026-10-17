import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { INTEGRATION_ID, integrationFixture, integrationPage, integrations, listHandler, problemResponse } from '@/lib/test/seller-integrations-fixtures';
import { origin, SELLER_SHOP_ID, shopFixture, VIEWER_PERMISSIONS } from '@/lib/test/seller-handlers';
import { IntegrationsView } from './integrations-view';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/integrations`,
  useSearchParams: () => new URLSearchParams(search),
}));

/**
 * W04 F3 (S08, `contracts/http-api.md`): connect with Shopify or WooCommerce, the list of integrations with their status,
 * and the result of the OAuth round trip (`?connected=`, `?error=`).
 */

let client: QueryClient;
const redirect = vi.fn();
function show(shop = shopFixture()) {
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shop)));
  return render(
    <QueryClientProvider client={client}>
      <IntegrationsView shopId={SELLER_SHOP_ID} onRedirect={redirect} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  search = '';
  vi.clearAllMocks();
});

describe('W04 F3 integrations list', () => {
  it('W04 F3-1: lists each store with provider, status, last sync, lag, linked products and what needs attention, linked to its page', async () => {
    server.use(
      listHandler([
        integrationFixture(),
        integrationFixture({ id: '11111111-aaaa-4bbb-8ccc-222222222222', provider: 'woocommerce', externalShop: 'https://shop.example.com', status: 'PAUSED', pausedReason: 'seller', lagSeconds: null, lastSyncAt: null, openQuarantine: 0, openConflicts: 0 }),
        integrationFixture({ id: '22222222-aaaa-4bbb-8ccc-333333333333', externalShop: 'old.myshopify.com', status: 'NEEDS_REAUTH' }),
      ]),
    );
    show();
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('clay-works.myshopify.com');
    expect(rows[0]).toHaveTextContent('Shopify');
    expect(rows[0]).toHaveTextContent('Active');
    expect(rows[0]).toHaveTextContent('2 min behind');
    expect(rows[0]).toHaveTextContent('42');
    expect(rows[0]).toHaveTextContent('3 need attention');
    expect(within(rows[0]).getByRole('link', { name: 'clay-works.myshopify.com' })).toHaveAttribute('href', `/dashboard/seller/${SELLER_SHOP_ID}/integrations/${INTEGRATION_ID}`);
    expect(rows[1]).toHaveTextContent('WooCommerce');
    expect(rows[1]).toHaveTextContent('Paused by you');
    expect(rows[1]).toHaveTextContent('Never');
    expect(rows[2]).toHaveTextContent('Needs to be reconnected');
  });

  it('W04 F3-2: with no integrations the empty text shows and both connect forms are offered', async () => {
    server.use(listHandler([]));
    show();
    expect(await screen.findByText('No stores connected yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Shopify' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect WooCommerce' })).toBeInTheDocument();
  });

  it('W04 F3-3: a failed list shows the problem with Try again, never the API detail', async () => {
    server.use(http.get(integrations, () => problemResponse(503, 'sync_unavailable')));
    show();
    expect(await screen.findByText("We couldn't load this right now. Try again in a moment.")).toBeInTheDocument();
    expect(screen.queryByText('Never shown detail')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('W04 F3-4: a member without integrations.manage sees the list and no connect form', async () => {
    server.use(listHandler());
    show(shopFixture({ myRole: 'VIEWER', myPermissions: [...VIEWER_PERMISSIONS] }));
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Connect Shopify' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect WooCommerce' })).not.toBeInTheDocument();
  });
});

describe('W04 F3 connect Shopify', () => {
  it('W04 F3-5: a bad domain is refused with no request; a good one calls POST …/shopify/install and sends the browser to authorizeUrl', async () => {
    let body: unknown;
    server.use(
      listHandler([]),
      http.post(`${integrations}/shopify/install`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ authorizeUrl: 'https://clay-works.myshopify.com/admin/oauth/authorize?client_id=abc&state=s', expiresAt: '2026-10-17T10:00:00.000Z' });
      }),
    );
    const user = userEvent.setup();
    show();
    const field = await screen.findByLabelText('Shopify store domain');
    await user.type(field, 'https://not-a-domain.example.com');
    await user.click(screen.getByRole('button', { name: 'Connect Shopify' }));
    expect(await screen.findByText('Enter your store domain, like your-store.myshopify.com.')).toBeInTheDocument();
    expect(body).toBeUndefined();

    await user.clear(field);
    await user.type(field, 'Clay-Works.myshopify.com');
    await user.click(screen.getByRole('button', { name: 'Connect Shopify' }));
    await waitFor(() => expect(redirect).toHaveBeenCalledWith('https://clay-works.myshopify.com/admin/oauth/authorize?client_id=abc&state=s'));
    expect(body).toEqual({ shopDomain: 'clay-works.myshopify.com' });
  });

  it('W04 F3-6: an authorizeUrl that is not https is never followed', async () => {
    server.use(listHandler([]), http.post(`${integrations}/shopify/install`, () => HttpResponse.json({ authorizeUrl: 'javascript:alert(1)', expiresAt: '2026-10-17T10:00:00.000Z' })));
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByLabelText('Shopify store domain'), 'clay-works.myshopify.com');
    await user.click(screen.getByRole('button', { name: 'Connect Shopify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side.');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('W04 F3-7: 429 on install shows the countdown', async () => {
    server.use(listHandler([]), http.post(`${integrations}/shopify/install`, () => problemResponse(429, 'rate_limited', {}, { 'retry-after': '30' })));
    const user = userEvent.setup();
    show();
    await user.type(await screen.findByLabelText('Shopify store domain'), 'clay-works.myshopify.com');
    await user.click(screen.getByRole('button', { name: 'Connect Shopify' }));
    expect(await screen.findByText(/Too many requests. Try again in \d+ s./)).toBeInTheDocument();
  });
});

describe('W04 F3 connect WooCommerce', () => {
  async function fill(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText('Store address'), 'https://shop.example.com');
    await user.type(screen.getByLabelText('Consumer key'), 'ck_abc123');
    await user.type(screen.getByLabelText('Consumer secret'), 'cs_secret456');
  }

  it('W04 F3-8: posts provider, storeUrl and both keys, then clears the secret, refreshes the list and shows a toast', async () => {
    let body: unknown;
    let created = false;
    server.use(
      http.get(integrations, () => HttpResponse.json(integrationPage(created ? [integrationFixture({ provider: 'woocommerce', externalShop: 'https://shop.example.com' })] : []))),
      http.post(integrations, async ({ request }) => {
        body = await request.json();
        created = true;
        return HttpResponse.json(integrationFixture({ provider: 'woocommerce', externalShop: 'https://shop.example.com' }), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    show();
    await fill(user);
    expect(screen.getByLabelText('Consumer secret')).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Connect WooCommerce' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Store connected'));
    expect(body).toEqual({ provider: 'woocommerce', storeUrl: 'https://shop.example.com', consumerKey: 'ck_abc123', consumerSecret: 'cs_secret456' });
    expect(screen.getByLabelText('Consumer secret')).toHaveValue('');
    expect(await screen.findByRole('table')).toHaveTextContent('https://shop.example.com');
    expect(document.body.innerHTML).not.toContain('cs_secret456');
    expect(JSON.stringify(client.getMutationCache().getAll().map((m) => m.state.data))).not.toContain('cs_secret456');
  });

  it('W04 F3-9: empty fields are refused with no request', async () => {
    const asked = vi.fn();
    server.use(listHandler([]), http.post(integrations, () => (asked(), problemResponse(500, 'x'))));
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Connect WooCommerce' }));
    expect(await screen.findByText('Enter the store address.')).toBeInTheDocument();
    expect(screen.getByText('Enter the consumer key.')).toBeInTheDocument();
    expect(screen.getByText('Enter the consumer secret.')).toBeInTheDocument();
    expect(asked).not.toHaveBeenCalled();
  });

  it.each([
    [422, 'invalid_store_url', 'Enter the address of a WooCommerce store, like https://shop.example.com.'],
    [422, 'provider_credentials_rejected', 'The store rejected these keys. Check the consumer key and secret and try again.'],
    [422, 'currency_mismatch', "The store's currency doesn't match this shop's currency."],
    [409, 'store_already_connected', 'This store is already connected to a shop.'],
    [409, 'integration_limit_reached', "You've reached the maximum number of integrations. Disconnect one to add another."],
    [503, 'provider_unavailable', "The store isn't answering right now. Try again in a moment."],
  ])('W04 F3-10: %i %s reads as its sentence and the secret stays out of the page', async (status, code, text) => {
    server.use(listHandler([]), http.post(integrations, () => problemResponse(status, code)));
    const user = userEvent.setup();
    show();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Connect WooCommerce' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText('Never shown detail')).not.toBeInTheDocument();
  });
});

describe('W04 F3 return from the OAuth round trip', () => {
  it('W04 F3-11: ?connected=<id> says the store is connected and links to it', async () => {
    search = `connected=${INTEGRATION_ID}`;
    server.use(listHandler());
    show();
    const banner = await screen.findByRole('status', { name: 'Connection result' });
    expect(banner).toHaveTextContent('Store connected.');
    expect(within(banner).getByRole('link', { name: 'Open integration' })).toHaveAttribute('href', `/dashboard/seller/${SELLER_SHOP_ID}/integrations/${INTEGRATION_ID}`);
  });

  it.each([
    ['oauth_exchange_failed', "We couldn't finish connecting the store. Try again."],
    ['currency_mismatch', "The store's currency doesn't match this shop's currency."],
    ['store_already_connected', 'This store is already connected to a shop.'],
    ['integration_limit_reached', "You've reached the maximum number of integrations. Disconnect one to add another."],
    ['something_new', "Connecting the store didn't work. Try again."],
  ])('W04 F3-12: ?error=%s reads as a sentence', async (code, text) => {
    search = `error=${code}`;
    server.use(listHandler());
    show();
    expect(await screen.findByRole('alert', { name: 'Connection result' })).toHaveTextContent(text);
  });

  it('W04 F3-13: a ?connected= value that is not an id is ignored', async () => {
    search = 'connected=%3Cscript%3E';
    server.use(listHandler());
    show();
    await screen.findByRole('table');
    expect(screen.queryByRole('status', { name: 'Connection result' })).not.toBeInTheDocument();
  });
});
