import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { server } from '../../../vitest.setup';
import { queryKeys } from '@/lib/query-keys';
import { versionFixture } from '@/lib/test/seller-developers-fixtures';
import { origin, SELLER_SHOP_ID, sellerProblem, shopFixture } from '@/lib/test/seller-handlers';
import { ApiVersionView } from './api-version-view';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/developers/api-version`,
  useSearchParams: () => new URLSearchParams(),
}));

const endpoint = `${origin}/api/shops/${SELLER_SHOP_ID}/developers/api-version`;

let client: QueryClient;
function show() {
  const shop = shopFixture();
  client.setQueryData(queryKeys.seller.shop(SELLER_SHOP_ID), shop);
  server.use(http.get(`${origin}/api/shops/${SELLER_SHOP_ID}`, () => HttpResponse.json(shop)));
  return render(
    <QueryClientProvider client={client}>
      <ApiVersionView shopId={SELLER_SHOP_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  vi.clearAllMocks();
});

describe('W04 API version', () => {
  it('W04 AS-68: shows the pinned version and date, the supported versions with badges, and Pin this version on the others', async () => {
    server.use(http.get(endpoint, () => HttpResponse.json(versionFixture())));
    show();
    const pinned = await screen.findByRole('region', { name: 'Pinned version' });
    expect(pinned).toHaveTextContent('2026-01-15');
    expect(pinned).toHaveTextContent(/Pinned on /);
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('2026-10-01');
    expect(rows[0]).toHaveTextContent('Latest');
    expect(within(rows[0]).getByRole('button', { name: 'Pin this version' })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('Supported');
    expect(within(rows[1]).queryByRole('button', { name: 'Pin this version' })).not.toBeInTheDocument();
    expect(rows[2]).toHaveTextContent(/Deprecated until /);
  });

  it('W04 AS-68: pinning asks first, sends the version, shows the new pin and toasts', async () => {
    let state = versionFixture();
    let body: unknown;
    server.use(
      http.get(endpoint, () => HttpResponse.json(state)),
      http.put(endpoint, async ({ request }) => {
        body = await request.json();
        state = versionFixture({ version: '2026-10-01', pinnedAt: '2026-10-17T10:00:00.000Z' });
        return HttpResponse.json({ version: '2026-10-01', previousVersion: '2026-01-15', pinnedAt: '2026-10-17T10:00:00.000Z' });
      }),
    );
    const user = userEvent.setup();
    show();
    const rows = within(await screen.findByRole('table')).getAllByRole('row').slice(1);
    await user.click(within(rows[0]).getByRole('button', { name: 'Pin this version' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pin version 2026-10-01?' });
    expect(dialog).toHaveTextContent('New requests without a version header will use 2026-10-01 within a few seconds.');
    expect(body).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Pin version' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('API version pinned'));
    expect(body).toEqual({ version: '2026-10-01' });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Pinned version' })).toHaveTextContent('2026-10-01'));
  });

  it('W04 AS-69: a deprecated pin is a warning at the top, not an error', async () => {
    server.use(http.get(endpoint, () => HttpResponse.json(versionFixture({ version: '2025-06-01' }))));
    show();
    const warning = await screen.findByRole('status');
    expect(warning).toHaveTextContent(/Version 2025-06-01 is deprecated and stops working on .+\. Pin 2026-10-01 after testing\./);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('W04 AS-69: version_retired is a refusal in the dialog', async () => {
    server.use(http.get(endpoint, () => HttpResponse.json(versionFixture())), http.put(endpoint, () => sellerProblem('version_retired')));
    const user = userEvent.setup();
    show();
    const rows = within(await screen.findByRole('table')).getAllByRole('row').slice(1);
    await user.click(within(rows[0]).getByRole('button', { name: 'Pin this version' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pin version 2026-10-01?' });
    await user.click(within(dialog).getByRole('button', { name: 'Pin version' }));
    expect(await within(dialog).findByText("That version is retired and can't be pinned.")).toBeInTheDocument();
  });

  it('W04 AS-69: a retired version is listed without a Pin button', async () => {
    server.use(http.get(endpoint, () => HttpResponse.json(versionFixture({ supported: [{ version: '2026-01-15', status: 'supported' }, { version: '2024-01-01', status: 'retired' }] }))));
    show();
    const rows = within(await screen.findByRole('table')).getAllByRole('row').slice(1);
    expect(rows[1]).toHaveTextContent('Retired');
    expect(within(rows[1]).queryByRole('button', { name: 'Pin this version' })).not.toBeInTheDocument();
  });
});
