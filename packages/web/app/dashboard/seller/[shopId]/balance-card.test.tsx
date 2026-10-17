import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../../vitest.setup';
import { origin, SELLER_SHOP_ID } from '@/lib/test/seller-handlers';
import { problemResponse } from '@/lib/test/seller-problem';
import { formatMoney } from '@/lib/utils';
import { BalanceCard } from './balance-card';

vi.mock('next/navigation', () => ({ usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}`, useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/auth/session-ended', () => ({ endSession: vi.fn(), setSessionEndHandler: vi.fn(), rearmSessionEnd: vi.fn() }));

const url = `${origin}/api/shops/${SELLER_SHOP_ID}/balance`;
const balance = (over: Record<string, unknown> = {}) => ({ shopId: SELLER_SHOP_ID, currency: 'EUR', availableMinor: 123456, asOf: '2026-10-17T10:00:00.000Z', source: 'read_model', ...over });

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BalanceCard shopId={SELLER_SHOP_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('W04 F5 balance card (S14)', () => {
  it('W04 F5: it reads GET /shops/:id/balance?currency=EUR and shows the available amount with its as-of time', async () => {
    let query = '';
    server.use(http.get(url, ({ request }) => ((query = new URL(request.url).search), HttpResponse.json(balance()))));
    show();
    await waitFor(() => expect(screen.getByTestId('balance-amount')).toHaveTextContent(formatMoney(123456, 'EUR')));
    expect(query).toBe('?currency=EUR');
    expect(screen.getByText(/As of/)).toBeInTheDocument();
  });

  it('W04 F5: a negative balance is shown as it is', async () => {
    server.use(http.get(url, () => HttpResponse.json(balance({ availableMinor: -2500, source: 'ledger' }))));
    show();
    await waitFor(() => expect(screen.getByTestId('balance-amount')).toHaveTextContent(formatMoney(-2500, 'EUR')));
  });

  it('W04 F5: the old { available, source: "projection" } shape is not accepted: an alert, no amount', async () => {
    server.use(http.get(url, () => HttpResponse.json({ shopId: SELLER_SHOP_ID, available: 1000, source: 'projection' })));
    show();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('balance-amount')).not.toBeInTheDocument();
  });

  it('W04 F5: a 400 (malformed shop id, unknown query) is an alert with fixed text, never the server detail', async () => {
    server.use(http.get(url, () => problemResponse('validation_failed', 400)));
    show();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Check the details and try again.');
    expect(alert).not.toHaveTextContent('Server detail');
    expect(screen.queryByTestId('balance-amount')).not.toBeInTheDocument();
  });
});
