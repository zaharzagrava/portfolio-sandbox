import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../../../vitest.setup';
import { origin, SELLER_SHOP_ID } from '@/lib/test/seller-handlers';
import { problemResponse } from '@/lib/test/seller-problem';
import { formatMoney } from '@/lib/utils';
import { StatementsView } from './view';

vi.mock('next/navigation', () => ({ usePathname: () => `/dashboard/seller/${SELLER_SHOP_ID}/statements`, useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/auth/session-ended', () => ({ endSession: vi.fn(), setSessionEndHandler: vi.fn(), rearmSessionEnd: vi.fn() }));

const base = `${origin}/api/shops/${SELLER_SHOP_ID}/statements`;
const totals = (over: Record<string, unknown> = {}) => ({ lineCount: 3, grossMinor: 100000, commissionMinor: 10000, netMinor: 90000, payoutsPaidMinor: 40000, ...over });
const statement = (month: string, over: Record<string, unknown> = {}) => ({
  shopId: SELLER_SHOP_ID,
  month,
  currency: 'EUR',
  status: 'OPEN',
  source: 'live',
  knownAt: '2026-10-17T10:00:00.000Z',
  dataAsOf: '2026-10-17T09:59:00.000Z',
  own: totals(),
  adjustmentsBooked: [],
  adjustmentsReferencing: [],
  total: totals(),
  corrected: totals(),
  unpricedLineCount: 0,
  ...over,
});
const page = { items: [{ month: '2026-10', status: 'OPEN', total: totals() }, { month: '2026-09', status: 'CLOSED', total: totals() }], nextCursor: null };

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StatementsView shopId={SELLER_SHOP_ID} />
    </QueryClientProvider>,
  );
}

let knownAts: (string | null)[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  knownAts = [];
  server.use(
    http.get(base, () => HttpResponse.json(page)),
    http.get(`${base}/:month`, ({ request, params }) => {
      knownAts.push(new URL(request.url).searchParams.get('knownAt'));
      return HttpResponse.json(statement(String(params.month), new URL(request.url).searchParams.has('knownAt') ? { source: 'as_known_at' } : {}));
    }),
  );
});

describe('W04 F5 statements (S16)', () => {
  it('W04 F5: the newest month opens first with gross, commission, net, lines and paid out as money', async () => {
    show();
    expect(await screen.findByTestId('statement-gross')).toHaveTextContent(formatMoney(100000, 'EUR'));
    expect(screen.getByTestId('statement-commission')).toHaveTextContent(formatMoney(10000, 'EUR'));
    expect(screen.getByTestId('statement-net')).toHaveTextContent(formatMoney(90000, 'EUR'));
    expect(screen.getByTestId('statement-paid-out')).toHaveTextContent(formatMoney(40000, 'EUR'));
    expect(screen.getByLabelText('Month')).toHaveValue('2026-10');
  });

  it('W04 F5: the CSV link points at the lines.csv of the month and carries knownAt once a day is picked', async () => {
    show();
    const link = await screen.findByRole('link', { name: 'Download CSV' });
    expect(link).toHaveAttribute('href', `/api/shops/${SELLER_SHOP_ID}/statements/2026-10/lines.csv`);
    fireEvent.change(screen.getByLabelText('As known on'), { target: { value: '2026-10-10' } });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Download CSV' })).toHaveAttribute('href', expect.stringContaining('knownAt=2026-10-10T23%3A59%3A59.999Z')));
  });

  it('W04 F5: the "as known on" picker asks for the statement at the end of that day and says so', async () => {
    show();
    await screen.findByTestId('statement');
    fireEvent.change(screen.getByLabelText('As known on'), { target: { value: '2026-10-10' } });
    expect(await screen.findByText(/As it was known on the chosen day/)).toBeInTheDocument();
    expect(knownAts).toContain('2026-10-10T23:59:59.999Z');
  });

  it('W04 F5: a known_at_in_future 422 is fixed text, never the server detail', async () => {
    server.use(http.get(`${base}/:month`, () => problemResponse('known_at_in_future', 422)));
    show();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Pick a day that is not in the future.');
    expect(alert).not.toHaveTextContent('Server detail');
  });

  it('W04 F5: no statements yet says so', async () => {
    server.use(http.get(base, () => HttpResponse.json({ items: [], nextCursor: null })));
    show();
    await waitFor(() => expect(screen.getByTestId('statement-empty')).toHaveTextContent('No statements yet.'));
    expect(screen.queryByRole('link', { name: 'Download CSV' })).not.toBeInTheDocument();
  });
});
