import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../../../vitest.setup';
import { origin, SELLER_SHOP_ID } from '@/lib/test/seller-handlers';
import { problemResponse } from '@/lib/test/seller-problem';
import { formatMoney } from '@/lib/utils';
import { PayoutsView } from './view';

vi.mock('next/navigation', () => ({ usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/payouts`, useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/auth/session-ended', () => ({ endSession: vi.fn(), setSessionEndHandler: vi.fn(), rearmSessionEnd: vi.fn() }));

const base = `${origin}/api/shops/${SELLER_SHOP_ID}/payouts`;
const payout = (n: number, status: string, over: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  shopId: SELLER_SHOP_ID,
  periodStart: `2026-09-${String(n).padStart(2, '0')}`,
  amountMinor: 10000 * n,
  reserveHeldMinor: 0,
  currency: 'EUR',
  status,
  transferRef: null,
  failureCode: null,
  createdAt: '2026-10-05T04:00:00.000Z',
  paidAt: status === 'PAID' ? '2026-10-06T08:00:00.000Z' : null,
  ...over,
});
const upcoming = (over: Record<string, unknown> = {}) => ({
  shopId: SELLER_SHOP_ID,
  currency: 'EUR',
  availableMinor: 50000,
  reserveMinor: 5000,
  estimatedPayoutMinor: 45000,
  nextRunAt: '2026-10-19T04:00:00.000Z',
  blockedReason: null,
  ...over,
});

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PayoutsView shopId={SELLER_SHOP_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  server.use(
    http.get(`${base}/upcoming`, () => HttpResponse.json(upcoming())),
    http.get(`${origin}/api/shops/${SELLER_SHOP_ID}/balance`, () => HttpResponse.json({ shopId: SELLER_SHOP_ID, currency: 'EUR', availableMinor: 50000, asOf: '2026-10-17T10:00:00.000Z', source: 'ledger' })),
  );
});

describe('W04 F5 payouts (S15)', () => {
  it('W04 F5: every public status has its own label; amounts are money, the paid date is shown only when paid', async () => {
    const statuses = ['PENDING', 'IN_TRANSIT', 'PAID', 'FAILED', 'CANCELLED'];
    server.use(http.get(base, () => HttpResponse.json({ items: statuses.map((s, i) => payout(i + 1, s)), nextCursor: null })));
    show();
    const rows = await screen.findAllByTestId('payout-row');
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => within(row).getByText(/^(Pending|In transit|Paid|Failed|Cancelled)$/).textContent)).toEqual(['Pending', 'In transit', 'Paid', 'Failed', 'Cancelled']);
    expect(rows[2]).toHaveTextContent(formatMoney(30000, 'EUR'));
  });

  it('W04 F5: the upcoming payout shows the estimate, the balance and the reserve; a blocked one says why in fixed words', async () => {
    server.use(
      http.get(base, () => HttpResponse.json({ items: [], nextCursor: null })),
      http.get(`${base}/upcoming`, () => HttpResponse.json(upcoming({ estimatedPayoutMinor: 0, blockedReason: 'destination_cooling' }))),
    );
    show();
    expect(await screen.findByTestId('upcoming-blocked')).toHaveTextContent('Your new payout destination is still in its waiting period.');
    expect(screen.getByTestId('upcoming-estimate')).toHaveTextContent(formatMoney(0, 'EUR'));
    expect(screen.getByTestId('payouts-empty')).toHaveTextContent('No payouts yet.');
  });

  it('W04 F5: "Show more" follows the keyset nextCursor and appends the next page', async () => {
    const cursors: (string | null)[] = [];
    server.use(
      http.get(base, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursors.push(cursor);
        return HttpResponse.json(cursor ? { items: [payout(2, 'PAID')], nextCursor: null } : { items: [payout(1, 'PENDING')], nextCursor: 'abc_123' });
      }),
    );
    const user = userEvent.setup();
    show();
    await screen.findAllByTestId('payout-row');
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findAllByTestId('payout-row')).toHaveLength(2);
    expect(cursors).toEqual([null, 'abc_123']);
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('W04 F5: a payout page that does not match payoutPageSchema (an unknown status) is an alert, not a table', async () => {
    server.use(http.get(base, () => HttpResponse.json({ items: [payout(1, 'SENDING')], nextCursor: null })));
    show();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('payout-row')).not.toBeInTheDocument();
  });

  it('W04 F5: a 403 on the history is fixed text with no server detail', async () => {
    server.use(http.get(base, () => problemResponse('permission_denied', 403)));
    show();
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('Server');
  });
});
