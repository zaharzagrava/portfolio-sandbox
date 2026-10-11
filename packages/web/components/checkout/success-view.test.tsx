import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderPageResponse } from '@marketplace-sandbox/contracts';
import { setSessionPresence } from '@/lib/api/session-presence';
import { queryKeys } from '@/lib/query-keys';
import { resetUserStream } from '@/lib/realtime/user-stream';
import { formatMoney } from '@/lib/utils';
import { installEventSourceStub, type EventSourceStub } from '@/tests/stubs/event-source';
import { ORDER_ID, orderBody, problemResponse } from '../../tests/msw/handlers';
import { server } from '../../vitest.setup';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const trackCheckoutStep = vi.hoisted(() => vi.fn());
vi.mock('@/lib/checkout/events', () => ({ trackCheckoutStep }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** The one decision point of "confirmed" (SC-003). Real by default; a test can take it over to prove nothing else decides. */
const decision = vi.hoisted(() => ({ override: null as ((status: string) => boolean) | null }));
vi.mock('@/lib/checkout/status', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/checkout/status')>();
  return { ...real, isConfirmed: (status: Parameters<typeof real.isConfirmed>[0]) => (decision.override ? decision.override(status) : real.isConfirmed(status)) };
});

import { SuccessView } from './success-view';

const origin = 'http://localhost:3000';
const USER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PAYMENT_ID = 'c0a8f6b2-1d3e-4f5a-9b7c-2e4d6f8a0b1c';
const AT = '2026-10-11T10:00:00.000Z';
const TOTAL = formatMoney(3998, 'EUR');

type Page = OrderPageResponse;
type Payment = NonNullable<Page['payment']>;
type OrderStatus = Page['order']['status'];

const payment = (over: Partial<Payment> = {}): Payment => ({
  id: PAYMENT_ID,
  status: 'COMPLETED',
  amountMinor: 3998,
  currency: 'EUR',
  failureCode: null,
  requiresAction: false,
  version: 2,
  updatedAt: AT,
  ...over,
});

function aggregate(over: { status?: OrderStatus; payment?: Payment | null; reason?: string | null } = {}): Page {
  const status = over.status ?? 'PAID';
  const timeline: Page['order']['timeline'] = [{ status: 'RESERVED', reason: null, at: AT }];
  if (status !== 'RESERVED') timeline.push({ status, reason: over.reason ?? null, at: AT });
  return { order: orderBody({ status, timeline }), payment: over.payment === undefined ? null : over.payment, errors: [] };
}

let backend: Page;
let reads = 0;
let client: QueryClient;
let stream: EventSourceStub;

function renderView(page: Page) {
  backend = page;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.auth.session(), { id: USER, email: 'a@b.co', role: 'USER' });
  client.setQueryData(queryKeys.orders.detail(ORDER_ID), page);
  return render(
    <QueryClientProvider client={client}>
      <SuccessView orderId={ORDER_ID} />
    </QueryClientProvider>,
  );
}

function emitOrder(status: OrderStatus) {
  act(() => {
    stream.last().open();
    stream.last().emit('order.status', { topic: `user:${USER}`, data: { orderId: ORDER_ID, status } });
  });
}

beforeEach(() => {
  decision.override = null;
  router.push.mockReset();
  router.replace.mockReset();
  trackCheckoutStep.mockReset();
  setSessionPresence(() => false);
  stream = installEventSourceStub();
  reads = 0;
  server.use(
    http.get(`${origin}/api/bff/orders/:id`, () => {
      reads += 1;
      return HttpResponse.json(backend);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetUserStream();
  stream.restore();
});

describe('Success view', () => {
  describe('a paid order (AS-48)', () => {
    it('W03 AS-48: says "Order confirmed" with the short order number, total, item count, lines, the email note and the two actions', async () => {
      renderView(aggregate({ status: 'PAID', payment: payment() }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Order confirmed' })).toBeInTheDocument();
      expect(screen.getByText(`Order #${ORDER_ID.slice(0, 8).toUpperCase()}`)).toBeInTheDocument();
      expect(screen.getByText('Total').closest('dl')).toHaveTextContent(TOTAL);
      expect(screen.getByText('2 items')).toBeInTheDocument();
      expect(screen.getByText('Headphones')).toBeInTheDocument();
      expect(screen.getByText("We'll email you a confirmation.")).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'View order' })).toHaveAttribute('href', `/orders/${ORDER_ID}`);
      expect(screen.getByRole('link', { name: 'Continue shopping' })).toHaveAttribute('href', '/search');
    });

    it.each(['PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED'] as const)('W03 AS-48: a %s order is confirmed', async (status) => {
      renderView(aggregate({ status }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Order confirmed' })).toBeInTheDocument();
    });

    it('W03 AS-48: focus moves to the <h1> on arrival and is not taken back after a refresh', async () => {
      renderView(aggregate({ status: 'PAID' }));
      const heading = await screen.findByRole('heading', { level: 1, name: 'Order confirmed' });
      await waitFor(() => expect(heading).toHaveFocus());

      act(() => heading.blur());
      await act(async () => {
        await client.invalidateQueries({ queryKey: queryKeys.orders.detail(ORDER_ID) });
      });
      expect(reads).toBeGreaterThan(0);
      expect(heading).not.toHaveFocus();
    });

    it('W03 AS-48: the confirmation is announced once: the heading is the only place it is written', async () => {
      renderView(aggregate({ status: 'PAID' }));
      await screen.findByRole('heading', { name: 'Order confirmed' });
      expect(screen.getAllByText('Order confirmed')).toHaveLength(1);
      expect(screen.queryAllByRole('alert')).toHaveLength(0);
    });

    it('W03 AS-48: checkout_step success is emitted once with the unit count and the order id, and not again by a refresh', async () => {
      renderView(aggregate({ status: 'PAID' }));
      await screen.findByRole('heading', { name: 'Order confirmed' });
      expect(trackCheckoutStep).toHaveBeenCalledTimes(1);
      expect(trackCheckoutStep).toHaveBeenCalledWith({ step: 'success', items: 2, orderId: ORDER_ID });
      await act(async () => {
        await client.invalidateQueries({ queryKey: queryKeys.orders.detail(ORDER_ID) });
      });
      expect(trackCheckoutStep).toHaveBeenCalledTimes(1);
    });

    it('W03 AS-48: a payment that is still being confirmed becomes "Order confirmed" when the order turns PAID, and focus follows', async () => {
      renderView(aggregate({ status: 'RESERVED', payment: payment({ status: 'COMPLETED' }) }));
      expect(await screen.findByText('Payment received. Confirming your order…')).toBeInTheDocument();
      expect(trackCheckoutStep).not.toHaveBeenCalled();

      backend = aggregate({ status: 'PAID', payment: payment() });
      emitOrder('PAID');
      const heading = await screen.findByRole('heading', { level: 1, name: 'Order confirmed' });
      await waitFor(() => expect(heading).toHaveFocus());
      expect(trackCheckoutStep).toHaveBeenCalledWith({ step: 'success', items: 2, orderId: ORDER_ID });
    });
  });

  describe('an order that is not confirmed (AS-49, SC-003)', () => {
    it('W03 AS-49: RESERVED with no payment says "You haven\'t paid for this order yet." with Continue to payment', async () => {
      renderView(aggregate({ status: 'RESERVED', payment: null }));
      expect(await screen.findByRole('heading', { level: 1, name: "You haven't paid for this order yet." })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Continue to payment' })).toHaveAttribute('href', `/checkout/pay/${ORDER_ID}`);
    });

    it('W03 AS-49: RESERVED with a payment in progress shows the processing panel', async () => {
      renderView(aggregate({ status: 'RESERVED', payment: payment({ status: 'PENDING' }) }));
      const panel = await screen.findByText('Payment is being processed…');
      expect(panel.closest('[role="status"]')).not.toBeNull();
    });

    it('W03 AS-49: RESERVED with a COMPLETED payment shows "Payment received. Confirming your order…"', async () => {
      renderView(aggregate({ status: 'RESERVED', payment: payment({ status: 'COMPLETED' }) }));
      expect(await screen.findByText('Payment received. Confirming your order…')).toBeInTheDocument();
    });

    it('W03 AS-49: RESERVED with an UNKNOWN payment tells the buyer not to pay again', async () => {
      renderView(aggregate({ status: 'RESERVED', payment: payment({ status: 'UNKNOWN' }) }));
      expect(await screen.findByText(/Please don't pay again\./)).toBeInTheDocument();
    });

    it('W03 AS-49: RESERVED with a FAILED payment shows the failure copy and no confirmation', async () => {
      renderView(aggregate({ status: 'RESERVED', payment: payment({ status: 'FAILED', failureCode: 'card_declined' }) }));
      expect(await screen.findByText('Your card was declined.')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: "Payment didn't go through" })).toBeInTheDocument();
    });

    it('W03 AS-49: a RESERVED payment that needs the bank sends the buyer back to the pay step', async () => {
      renderView(aggregate({ status: 'RESERVED', payment: payment({ status: 'PENDING', requiresAction: true }) }));
      expect(await screen.findByText('Your bank needs you to confirm this payment.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Continue to payment' })).toHaveAttribute('href', `/checkout/pay/${ORDER_ID}`);
    });

    it('W03 AS-49: a PENDING order says it is still being reserved', async () => {
      renderView(aggregate({ status: 'PENDING' }));
      expect(await screen.findByText('Reserving your items…')).toBeInTheDocument();
    });

    it.each([
      ['out_of_stock', 'Some items sold out.'],
      ['payment_failed', "The payment didn't go through."],
      ['hold_expired', 'The reservation ended before payment.'],
      ['user_cancelled', 'You cancelled this order.'],
    ])('W03 AS-49: a CANCELLED order (%s) shows the AS-43 copy', async (reason, sentence) => {
      renderView(aggregate({ status: 'CANCELLED', reason }));
      expect(await screen.findByRole('heading', { level: 1, name: 'This order was cancelled' })).toBeInTheDocument();
      expect(screen.getByText(sentence)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Buy these items again' })).toBeInTheDocument();
    });

    it('W03 AS-49: a CANCELLED order whose payment arrived late adds the refund notice', async () => {
      renderView(aggregate({ status: 'CANCELLED', reason: 'hold_expired', payment: payment({ status: 'COMPLETED' }) }));
      expect(await screen.findByText('Your payment arrived after the reservation ended. It will be refunded automatically.')).toBeInTheDocument();
    });

    it('W03 AS-49: a REFUNDED order says "This order was refunded."', async () => {
      renderView(aggregate({ status: 'REFUNDED', payment: payment({ status: 'REFUNDED' }) }));
      expect(await screen.findByRole('heading', { level: 1, name: 'This order was refunded.' })).toBeInTheDocument();
    });

    const states: [string, Page][] = [
      ['PENDING', aggregate({ status: 'PENDING' })],
      ['RESERVED, no payment', aggregate({ status: 'RESERVED', payment: null })],
      ['RESERVED, PENDING payment', aggregate({ status: 'RESERVED', payment: payment({ status: 'PENDING' }) })],
      ['RESERVED, action required', aggregate({ status: 'RESERVED', payment: payment({ status: 'PENDING', requiresAction: true }) })],
      ['RESERVED, UNKNOWN payment', aggregate({ status: 'RESERVED', payment: payment({ status: 'UNKNOWN' }) })],
      ['RESERVED, COMPLETED payment', aggregate({ status: 'RESERVED', payment: payment({ status: 'COMPLETED' }) })],
      ['RESERVED, FAILED payment', aggregate({ status: 'RESERVED', payment: payment({ status: 'FAILED', failureCode: null }) })],
      ['CANCELLED', aggregate({ status: 'CANCELLED', reason: 'payment_failed' })],
      ['CANCELLED, refund pending', aggregate({ status: 'CANCELLED', reason: 'hold_expired', payment: payment({ status: 'REFUND_PENDING' }) })],
      ['REFUNDED', aggregate({ status: 'REFUNDED', payment: payment({ status: 'REFUNDED' }) })],
    ];

    it.each(states)('SC-003 W03 AS-49: %s never says the order is confirmed and has exactly one <h1>', async (_name, page) => {
      const { container } = renderView(page);
      await screen.findByRole('heading', { level: 1 });
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(container.textContent).not.toMatch(/order confirmed/i);
      expect(container.textContent).not.toContain("We'll email you a confirmation.");
      expect(trackCheckoutStep).not.toHaveBeenCalled();
      expect(screen.queryByRole('link', { name: 'Continue shopping' })).not.toBeInTheDocument();
    });
  });

  describe('only isConfirmed decides (SC-003)', () => {
    it('W03 AS-48: when isConfirmed says no, even a PAID order is not announced as confirmed', async () => {
      decision.override = () => false;
      const { container } = renderView(aggregate({ status: 'PAID', payment: payment() }));
      await screen.findByRole('heading', { level: 1 });
      expect(container.textContent).not.toMatch(/order confirmed/i);
    });

    it('W03 AS-48: when isConfirmed says yes, the view follows it (it keeps no list of statuses of its own)', async () => {
      decision.override = () => true;
      renderView(aggregate({ status: 'RESERVED', payment: null }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Order confirmed' })).toBeInTheDocument();
    });
  });

  describe('loading, failure and stream health', () => {
    it('W03 AS-48: while the order is read the view is a status, and a failed read says so with Try again', async () => {
      server.use(http.get(`${origin}/api/bff/orders/:id`, () => problemResponse(503, 'unavailable', { requestId: 'req-503' })));
      client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(queryKeys.auth.session(), { id: USER, email: 'a@b.co', role: 'USER' });
      render(
        <QueryClientProvider client={client}>
          <SuccessView orderId={ORDER_ID} />
        </QueryClientProvider>,
      );
      expect(screen.getByRole('status')).toHaveTextContent('Loading your order…');
      // The read hook retries a 5xx once (after its back-off) before giving up.
      const alert = await screen.findByRole('alert', {}, { timeout: 5000 });
      expect(alert).toHaveTextContent("We couldn't load your order.");
      expect(alert).not.toHaveTextContent(/confirmed/i);
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('W03 AS-45: "Live updates paused. Reconnecting…" shows once while the stream reconnects', async () => {
      renderView(aggregate({ status: 'RESERVED', payment: payment({ status: 'COMPLETED' }) }));
      await screen.findByText('Payment received. Confirming your order…');
      act(() => stream.last().open());
      act(() => stream.last().fail());
      expect(screen.getAllByText('Live updates paused. Reconnecting…')).toHaveLength(1);
    });
  });
});
