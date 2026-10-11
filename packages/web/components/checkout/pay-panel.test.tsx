import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderPageResponse } from '@marketplace-sandbox/contracts';
import { setSessionPresence } from '@/lib/api/session-presence';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { payAttemptKey } from '@/lib/checkout/attempt-store';
import { queryKeys } from '@/lib/query-keys';
import { resetUserStream } from '@/lib/realtime/user-stream';
import { formatMoney } from '@/lib/utils';
import { installEventSourceStub, type EventSourceStub } from '@/tests/stubs/event-source';
import type { StubPaymentFieldsController } from '@/tests/stubs/payment-fields';
import { fakeCartBackend } from '../../tests/msw/cart-backend';
import { ORDER_ID, PRODUCT_A, orderBody, problemResponse } from '../../tests/msw/handlers';
import { server } from '../../vitest.setup';

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const trackCheckoutStep = vi.hoisted(() => vi.fn());
vi.mock('@/lib/checkout/events', () => ({ trackCheckoutStep }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** The provider's hosted fields and confirmation frame live in iframes jsdom cannot show: the stub stands in for the adapter. */
const provider = vi.hoisted(() => ({ controller: null as StubPaymentFieldsController | null, confirmAction: vi.fn() }));
vi.mock('./payment-fields', async () => {
  const { StubPaymentFields } = await import('@/tests/stubs/payment-fields');
  return {
    PaymentFields: (props: Parameters<typeof StubPaymentFields>[0]) => (
      <StubPaymentFields
        {...props}
        controllerRef={(controller) => {
          provider.controller = controller;
        }}
      />
    ),
    confirmPaymentAction: provider.confirmAction,
  };
});

import { PayPanel } from './pay-panel';

const origin = 'http://localhost:3000';
const USER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const PAYMENT_ID = 'c0a8f6b2-1d3e-4f5a-9b7c-2e4d6f8a0b1c';
const SECRET = 'pi_3Abc_secret_ZYX987';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOTAL = formatMoney(3998, 'EUR');
const AT = '2026-10-11T10:00:00.000Z';

type Page = OrderPageResponse;
type Payment = NonNullable<Page['payment']>;
type OrderStatus = Page['order']['status'];

const payment = (over: Partial<Payment> = {}): Payment => ({
  id: PAYMENT_ID,
  status: 'PENDING',
  amountMinor: 3998,
  currency: 'EUR',
  failureCode: null,
  requiresAction: false,
  version: 1,
  updatedAt: AT,
  ...over,
});

function aggregate(over: { status?: OrderStatus; payment?: Payment | null; reservedInSeconds?: number; reason?: string | null } = {}): Page {
  const status = over.status ?? 'RESERVED';
  const timeline: Page['order']['timeline'] = [{ status: 'RESERVED', reason: null, at: AT }];
  if (status !== 'RESERVED') timeline.push({ status, reason: over.reason ?? null, at: AT });
  return {
    order: orderBody({ status, reservedUntil: new Date(Date.now() + (over.reservedInSeconds ?? 900) * 1000).toISOString(), timeline }),
    payment: over.payment ?? null,
    errors: [],
  };
}

// --- a tiny stateful backend ---------------------------------------------------------------------------------------------
let backend: { page: Page; secret: string };
const calls = { orderReads: 0, paymentReads: 0, intents: [] as { body: unknown; key: string | null; auth: string | null }[] };
let answerIntent: (n: number) => Response | Promise<Response>;

const accepted = () => {
  backend.page = { ...backend.page, payment: payment() };
  return HttpResponse.json({ paymentId: PAYMENT_ID, orderId: ORDER_ID, status: 'PENDING', amountMinor: 3998, currency: 'EUR', createdAt: AT }, { status: 202 });
};

let client: QueryClient;
let stream: EventSourceStub;

function renderPanel(page: Page = aggregate()) {
  backend.page = page;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.auth.session(), { id: USER, email: 'a@b.co', role: 'USER' });
  client.setQueryData(queryKeys.orders.detail(ORDER_ID), page);
  return render(
    <QueryClientProvider client={client}>
      <PayPanel orderId={ORDER_ID} />
    </QueryClientProvider>,
  );
}

/** What the server does next: change the stored state, then tell the page the way the stream would. */
function emitPayment(status: Payment['status'], version = 2) {
  act(() => {
    stream.last().open();
    stream.last().emit('payment.status', { topic: `user:${USER}`, data: { paymentId: PAYMENT_ID, orderId: ORDER_ID, status, version } });
  });
}
function emitOrder(status: OrderStatus) {
  act(() => {
    stream.last().open();
    stream.last().emit('order.status', { topic: `user:${USER}`, data: { orderId: ORDER_ID, status } });
  });
}

const fields = () => provider.controller as StubPaymentFieldsController;
const payButton = () => screen.getByRole('button', { name: /^pay/i });
const queryPayButton = () => screen.queryByRole('button', { name: /^pay/i });
const cardGroup = () => screen.queryByRole('group', { name: 'Card details' });
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

async function pay(user = userEvent.setup()) {
  await screen.findByRole('group', { name: 'Card details' });
  act(() => fields().complete());
  await user.click(payButton());
}

beforeEach(() => {
  provider.controller = null;
  provider.confirmAction.mockReset().mockResolvedValue({ ok: true });
  router.push.mockReset();
  router.replace.mockReset();
  trackCheckoutStep.mockReset();
  sessionStorage.clear();
  localStorage.clear();
  rearmSessionEnd();
  setSessionPresence(() => false);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  stream = installEventSourceStub();
  backend = { page: aggregate(), secret: SECRET };
  calls.orderReads = 0;
  calls.paymentReads = 0;
  calls.intents = [];
  answerIntent = accepted;
  server.use(
    http.get(`${origin}/api/bff/orders/:id`, () => {
      calls.orderReads += 1;
      return HttpResponse.json(backend.page);
    }),
    http.get(`${origin}/api/payments/:id`, ({ params }) => {
      calls.paymentReads += 1;
      const current = backend.page.payment;
      if (!current || current.id !== params.id) return problemResponse(404, 'payment_not_found');
      return HttpResponse.json({ ...current, orderId: ORDER_ID, createdAt: AT, clientSecret: current.requiresAction ? backend.secret : null });
    }),
    http.post(`${origin}/api/payments/intents`, async ({ request }) => {
      calls.intents.push({ body: await request.json(), key: request.headers.get('idempotency-key'), auth: request.headers.get('authorization') });
      return answerIntent(calls.intents.length);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetUserStream();
  stream.restore();
  setSessionEndHandler(null);
});

describe('Pay panel', () => {
  describe('the pay form (AS-37)', () => {
    it('W03 AS-37: shows the order summary, the card group and Pay with the order total, disabled until the fields report complete', async () => {
      renderPanel();
      expect(await screen.findByRole('group', { name: 'Card details' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
      expect(screen.getByText(`Order summary, 2 items, ${TOTAL}`)).toBeInTheDocument();
      expect(screen.getByText('Headphones')).toBeInTheDocument();
      expect(payButton()).toHaveTextContent(`Pay ${TOTAL}`);
      expect(payButton()).toBeDisabled();

      act(() => fields().complete());
      expect(payButton()).toBeEnabled();
      act(() => fields().incomplete());
      expect(payButton()).toBeDisabled();
    });

    it('W03 AS-37: a provider error appears under the field, tied to it with aria-describedby, and is not announced until Pay is pressed', async () => {
      renderPanel();
      await screen.findByRole('group', { name: 'Card details' });
      act(() => fields().error('Your card number is incomplete.'));
      const message = screen.getByText('Your card number is incomplete.');
      expect(message.id).not.toBe('');
      expect(document.querySelector(`[aria-describedby~="${message.id}"]`)).not.toBeNull();
      expect(message).not.toHaveAttribute('role', 'alert');
    });

    it('W03 AS-37: when the provider refuses the fields on submit the error is an alert, nothing is sent, and the form stays usable', async () => {
      renderPanel();
      await screen.findByRole('group', { name: 'Card details' });
      act(() => fields().complete());
      fields().nextToken({ ok: false, error: 'Your card number is invalid.' });
      await userEvent.click(payButton());

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Your card number is invalid.');
      expect(document.querySelector(`[aria-describedby~="${alert.id}"]`)).not.toBeNull();
      expect(calls.intents).toHaveLength(0);
      expect(payButton()).toBeEnabled();
    });

    it('W03 AS-37: the page has no card input of its own and the request carries no card field', async () => {
      const { container } = renderPanel();
      await pay();
      await screen.findByText('Payment is being processed…');
      // The only inputs are the provider\'s own (the stub\'s read-only stand-ins); the page never reads or writes a value.
      for (const input of container.querySelectorAll('input')) {
        expect(input).toHaveAttribute('readonly');
        expect((input as HTMLInputElement).value).toBe('');
      }
      expect(container.querySelector('[autocomplete^="cc-"]')).toBeNull();
      expect(Object.keys(calls.intents[0].body as object).sort()).toEqual(['orderId', 'paymentMethodId']);
    });

    it('W03 AS-37: the pay step is reported once as checkout_step pay with the unit count and the order id', async () => {
      renderPanel();
      await screen.findByRole('group', { name: 'Card details' });
      expect(trackCheckoutStep).toHaveBeenCalledTimes(1);
      expect(trackCheckoutStep).toHaveBeenCalledWith({ step: 'pay', items: 2, orderId: ORDER_ID });
    });

    it('W03 AS-33: offline, Pay is disabled and the banner says so', async () => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      renderPanel();
      await screen.findByRole('group', { name: 'Card details' });
      act(() => fields().complete());
      expect(screen.getByText("You're offline. Reconnect to pay.")).toBeInTheDocument();
      expect(payButton()).toBeDisabled();
    });
  });

  describe('order states (AS-35, AS-43)', () => {
    it('W03 AS-35: a PENDING order says "Reserving your items…" as a status, shows no form, and the form appears when the order is RESERVED', async () => {
      renderPanel(aggregate({ status: 'PENDING' }));
      const status = await screen.findByText('Reserving your items…');
      expect(status.closest('[role="status"]')).not.toBeNull();
      expect(cardGroup()).not.toBeInTheDocument();

      backend.page = aggregate({ status: 'RESERVED' });
      emitOrder('RESERVED');
      expect(await screen.findByRole('group', { name: 'Card details' })).toBeInTheDocument();
    });

    it.each(['PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED'] as const)('W03 AS-35: a %s order moves to the success page and never shows the form', async (status) => {
      renderPanel(aggregate({ status, payment: payment({ status: 'COMPLETED' }) }));
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/checkout/success/${ORDER_ID}`));
      expect(router.replace).toHaveBeenCalledTimes(1);
      expect(cardGroup()).not.toBeInTheDocument();
    });

    it.each([
      ['out_of_stock', 'Some items sold out.'],
      ['payment_failed', "The payment didn't go through."],
      ['hold_expired', 'The reservation ended before payment.'],
      ['user_cancelled', 'You cancelled this order.'],
    ])('W03 AS-43: a CANCELLED order (%s) says so with its reason, Buy these items again and Your orders', async (reason, sentence) => {
      renderPanel(aggregate({ status: 'CANCELLED', reason }));
      expect(await screen.findByRole('heading', { name: 'This order was cancelled' })).toBeInTheDocument();
      expect(screen.getByText(sentence)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Buy these items again' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Your orders' })).toHaveAttribute('href', '/orders');
      expect(screen.queryByText(/refunded automatically/i)).not.toBeInTheDocument();
      expect(cardGroup()).not.toBeInTheDocument();
      expect(queryPayButton()).not.toBeInTheDocument();
    });

    it('W03 AS-43: a CANCELLED order with an unknown reason gives no reason sentence', async () => {
      renderPanel(aggregate({ status: 'CANCELLED', reason: 'something_new' }));
      expect(await screen.findByRole('heading', { name: 'This order was cancelled' })).toBeInTheDocument();
      expect(screen.queryByText('something_new')).not.toBeInTheDocument();
    });

    it.each(['COMPLETED', 'REFUND_PENDING', 'REFUNDED'] as const)('W03 AS-43: a CANCELLED order whose payment is %s adds the automatic refund notice', async (status) => {
      renderPanel(aggregate({ status: 'CANCELLED', reason: 'hold_expired', payment: payment({ status }) }));
      expect(await screen.findByText('Your payment arrived after the reservation ended. It will be refunded automatically.')).toBeInTheDocument();
    });

    it('W03 AS-43: a REFUNDED order says "This order was refunded."', async () => {
      renderPanel(aggregate({ status: 'REFUNDED', payment: payment({ status: 'REFUNDED' }) }));
      expect(await screen.findByRole('heading', { name: 'This order was refunded.' })).toBeInTheDocument();
      expect(cardGroup()).not.toBeInTheDocument();
    });

    it('W03 AS-43: Buy these items again puts each line back in the cart (current quantity plus the order\'s) and opens the cart', async () => {
      const cart = fakeCartBackend([{ productId: PRODUCT_A, quantity: 19 }]);
      server.use(...cart.handlers);
      renderPanel(aggregate({ status: 'CANCELLED', reason: 'payment_failed' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Buy these items again' }));
      await waitFor(() => expect(router.push).toHaveBeenCalledWith('/cart'));
      expect(cart.puts).toEqual([{ productId: PRODUCT_A, quantity: 20 }]);
    });

    it('W03 AS-36: the reservation timer shows while the form is open, and "Payment in progress" replaces it once paying', async () => {
      renderPanel();
      expect(await screen.findByRole('timer')).toHaveTextContent(/Items reserved for 1[45]:\d\d/);
      await pay();
      await screen.findByText('Payment is being processed…');
      expect(screen.queryByRole('timer')).not.toBeInTheDocument();
      expect(screen.getByText('Payment in progress')).toBeInTheDocument();
    });

    it('W03 AS-36: when the countdown ends with no payment the order is read again and the state the server reports is shown', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderPanel(aggregate({ reservedInSeconds: 5 }));
      await screen.findByRole('group', { name: 'Card details' });
      const before = calls.orderReads;
      backend.page = aggregate({ status: 'CANCELLED', reason: 'hold_expired' });
      await advance(6000);
      expect(await screen.findByRole('heading', { name: 'This order was cancelled' })).toBeInTheDocument();
      expect(screen.getByText('The reservation ended before payment.')).toBeInTheDocument();
      expect(calls.orderReads).toBeGreaterThan(before);
    });
  });

  describe('paying (AS-38, AS-47)', () => {
    it('W03 AS-38: Pay shows "Paying…" disabled, sends {orderId, paymentMethodId} with an Idempotency-Key and no Authorization, then shows the processing panel', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      answerIntent = async () => {
        await gate;
        return accepted();
      };
      renderPanel();
      await pay();

      expect(payButton()).toHaveTextContent('Paying…');
      expect(payButton()).toBeDisabled();
      expect(payButton()).toHaveAttribute('aria-busy', 'true');
      await waitFor(() => expect(calls.intents).toHaveLength(1));
      expect(calls.intents[0].body).toEqual({ orderId: ORDER_ID, paymentMethodId: 'pm_stub_card' });
      expect(calls.intents[0].key).toMatch(UUID);
      expect(calls.intents[0].auth).toBeNull();

      release();
      const status = await screen.findByText('Payment is being processed…');
      expect(status.closest('[role="status"]')).not.toBeNull();
      expect(cardGroup()).not.toBeInTheDocument();
      expect(queryPayButton()).not.toBeInTheDocument();
    });

    it('W03 AS-38: the status panel takes focus when it replaces the form', async () => {
      renderPanel();
      await pay();
      const heading = await screen.findByRole('heading', { name: 'Payment is being processed…' });
      await waitFor(() => expect(heading).toHaveFocus());
    });

    it('W03 AS-38: processing -> "Payment received. Confirming your order…" (never "confirmed") -> success page when the order is PAID', async () => {
      renderPanel();
      await pay();
      await screen.findByText('Payment is being processed…');

      backend.page = aggregate({ payment: payment({ status: 'COMPLETED', version: 2 }) });
      emitPayment('COMPLETED');
      expect(await screen.findByText('Payment received. Confirming your order…')).toBeInTheDocument();
      expect(screen.queryByText(/confirmed/i)).not.toBeInTheDocument();
      expect(router.replace).not.toHaveBeenCalled();

      backend.page = aggregate({ status: 'PAID', payment: payment({ status: 'COMPLETED', version: 2 }) });
      emitOrder('PAID');
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/checkout/success/${ORDER_ID}`));
    });

    it('W03 AS-47: two quick presses send one request', async () => {
      renderPanel();
      await screen.findByRole('group', { name: 'Card details' });
      act(() => fields().complete());
      const button = payButton();
      fireEvent.click(button);
      fireEvent.click(button);
      await screen.findByText('Payment is being processed…');
      expect(calls.intents).toHaveLength(1);
    });

    it('W03 AS-47: the pay attempt key is stored in the tab, and a reload while the request is pending sends the same key', async () => {
      answerIntent = () => new Promise<Response>(() => {});
      const first = renderPanel();
      await pay();
      await waitFor(() => expect(calls.intents).toHaveLength(1));
      const stored = JSON.parse(sessionStorage.getItem(payAttemptKey(ORDER_ID)) as string);
      expect(stored).toMatchObject({ key: calls.intents[0].key, paymentMethodId: 'pm_stub_card' });
      // Only the random key, the method token's name and a timestamp: nothing else is kept.
      expect(Object.keys(stored).sort()).toEqual(['createdAt', 'key', 'paymentMethodId']);

      first.unmount();
      provider.controller = null;
      renderPanel();
      await pay();
      await waitFor(() => expect(calls.intents).toHaveLength(2));
      expect(calls.intents[1].key).toBe(calls.intents[0].key);
    });

    it('W03 AS-47: a new payment method token is a new attempt with a new key', async () => {
      answerIntent = () => new Promise<Response>(() => {});
      const first = renderPanel();
      await pay();
      await waitFor(() => expect(calls.intents).toHaveLength(1));
      first.unmount();
      provider.controller = null;
      renderPanel();
      await screen.findByRole('group', { name: 'Card details' });
      fields().nextToken({ ok: true, paymentMethodId: 'pm_other_card' });
      await pay();
      await waitFor(() => expect(calls.intents).toHaveLength(2));
      expect(calls.intents[1].key).not.toBe(calls.intents[0].key);
    });
  });

  describe('payment states (AS-39, AS-41, AS-42, AS-46)', () => {
    it('W03 AS-39: a payment already PENDING when the page opens shows the processing panel and no form', async () => {
      renderPanel(aggregate({ payment: payment() }));
      expect(await screen.findByText('Payment is being processed…')).toBeInTheDocument();
      expect(cardGroup()).not.toBeInTheDocument();
    });

    it.each([
      ['card_declined', 'Your card was declined.'],
      ['insufficient_funds', 'Your card has insufficient funds.'],
      ['expired_card', 'Your card has expired.'],
      ['provider_rejected', "Your bank didn't accept this payment."],
      ['declined_other', "Your bank didn't accept this payment."],
      ['provider_unavailable', "The payment service had a problem. You weren't charged."],
      ['provider_canceled', "The payment service had a problem. You weren't charged."],
      ['no_provider_record', "The payment couldn't be completed."],
      ['order_cancelled', "The payment couldn't be completed."],
      [null, "The payment couldn't be completed."],
    ] as const)('W03 AS-41: a FAILED payment with code %s says "Payment didn\'t go through" and "%s"', async (failureCode, sentence) => {
      renderPanel(aggregate({ payment: payment({ status: 'FAILED', failureCode }) }));
      expect(await screen.findByRole('heading', { name: "Payment didn't go through" })).toBeInTheDocument();
      expect(screen.getByText(sentence)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Buy these items again' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'View order' })).toHaveAttribute('href', `/orders/${ORDER_ID}`);
      // There is no retry on the same order: no Pay, no Try again, no card fields.
      expect(queryPayButton()).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /try again|retry/i })).not.toBeInTheDocument();
      expect(cardGroup()).not.toBeInTheDocument();
    });

    it('W03 AS-41: a payment that fails while the page is open shows the failure panel', async () => {
      renderPanel();
      await pay();
      await screen.findByText('Payment is being processed…');
      backend.page = aggregate({ payment: payment({ status: 'FAILED', failureCode: 'card_declined', version: 2 }) });
      emitPayment('FAILED');
      expect(await screen.findByText('Your card was declined.')).toBeInTheDocument();
    });

    it('W03 AS-42: an UNKNOWN payment says it is being confirmed with the bank, offers no Pay button, and settles to the success page', async () => {
      renderPanel(aggregate({ payment: payment({ status: 'UNKNOWN' }) }));
      expect(await screen.findByText("We're confirming your payment with your bank. This can take a few minutes. Please don't pay again.")).toBeInTheDocument();
      expect(queryPayButton()).not.toBeInTheDocument();
      expect(cardGroup()).not.toBeInTheDocument();

      backend.page = aggregate({ status: 'PAID', payment: payment({ status: 'COMPLETED', version: 2 }) });
      emitPayment('COMPLETED');
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/checkout/success/${ORDER_ID}`));
    });

    it('W03 AS-42: an UNKNOWN payment that fails shows the failure panel', async () => {
      renderPanel(aggregate({ payment: payment({ status: 'UNKNOWN' }) }));
      await screen.findByText(/confirming your payment with your bank/);
      backend.page = aggregate({ payment: payment({ status: 'FAILED', failureCode: 'expired_card', version: 2 }) });
      emitPayment('FAILED');
      expect(await screen.findByText('Your card has expired.')).toBeInTheDocument();
    });

    it('W03 AS-46: a COMPLETED payment on a RESERVED order says "Confirming your order" (never "confirmed") and adds a hint after 60 seconds', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderPanel(aggregate({ payment: payment({ status: 'COMPLETED' }) }));
      expect(await screen.findByText('Payment received. Confirming your order…')).toBeInTheDocument();
      expect(screen.queryByText(/confirmed/i)).not.toBeInTheDocument();
      await advance(59_000);
      expect(screen.queryByText(/taking longer than usual/i)).not.toBeInTheDocument();
      await advance(2000);
      expect(screen.getByText('This is taking longer than usual. You can leave this page; your order will appear in Your orders as soon as it is confirmed.')).toBeInTheDocument();
      expect(screen.queryByText('Order confirmed')).not.toBeInTheDocument();
    });
  });

  describe('live updates and the polling fallback (AS-39, AS-45)', () => {
    it('W03 AS-45: "Live updates paused. Reconnecting…" shows once while the stream reconnects and goes when it is back; a resync re-reads the order', async () => {
      renderPanel();
      await screen.findByRole('group', { name: 'Card details' });
      act(() => stream.last().open());
      expect(screen.queryByText('Live updates paused. Reconnecting…')).not.toBeInTheDocument();
      act(() => stream.last().fail());
      expect(screen.getAllByText('Live updates paused. Reconnecting…')).toHaveLength(1);
      act(() => stream.last().open());
      await waitFor(() => expect(screen.queryByText('Live updates paused. Reconnecting…')).not.toBeInTheDocument());

      const reads = calls.orderReads;
      act(() => stream.last().emit('resync', { reason: 'replay_window_lost' }));
      await waitFor(() => expect(calls.orderReads).toBeGreaterThan(reads));
    });

    it('W03 AS-39: after 10 s of silence the order is polled every 2 s, and an event stops the polling', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderPanel(aggregate({ payment: payment() }));
      await screen.findByText('Payment is being processed…');
      act(() => stream.last().open());
      await advance(9_000);
      const quiet = calls.orderReads;
      await advance(1_000); // silence reached: polling starts
      await advance(2_000);
      await waitFor(() => expect(calls.orderReads).toBe(quiet + 1));
      await advance(2_000);
      await waitFor(() => expect(calls.orderReads).toBe(quiet + 2));

      emitOrder('RESERVED'); // any event is a sign of life
      const settled = calls.orderReads;
      await advance(1_000);
      const afterEvent = calls.orderReads;
      await advance(8_000);
      expect(calls.orderReads).toBe(afterEvent);
      expect(afterEvent).toBeGreaterThanOrEqual(settled);
    });

    it('W03 AS-39: when the schedule is over the page says it is taking longer and offers Check again', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderPanel(aggregate({ payment: payment() }));
      await screen.findByText('Payment is being processed…');
      act(() => stream.last().open());
      await advance(10_000 + 30_000 + 300_000 + 1_000);
      expect(await screen.findByText(/This is taking longer than expected\. You can leave this page; we'll email you and it will show in/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Your orders' })).toHaveAttribute('href', '/orders');

      const reads = calls.orderReads;
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await waitFor(() => expect(calls.orderReads).toBeGreaterThan(reads));
    });
  });

  describe('3-D Secure (AS-40)', () => {
    const needsAction = () => aggregate({ payment: payment({ requiresAction: true }) });

    it('W03 AS-40: opens the provider frame with the secret read from the payment, in memory only', async () => {
      renderPanel(needsAction());
      await waitFor(() => expect(provider.confirmAction).toHaveBeenCalledWith(SECRET));
      expect(provider.confirmAction).toHaveBeenCalledTimes(1);
      expect(calls.paymentReads).toBeGreaterThan(0);
      await screen.findByText('Payment is being processed…');

      // The secret is nowhere a script, a reload or a URL could find it.
      const stored = [...Array(sessionStorage.length).keys()].map((i) => sessionStorage.getItem(sessionStorage.key(i) as string)).concat(
        [...Array(localStorage.length).keys()].map((i) => localStorage.getItem(localStorage.key(i) as string)),
      );
      expect(stored.join('|')).not.toContain(SECRET);
      expect(window.location.href).not.toContain(SECRET);
      expect(document.body.innerHTML).not.toContain(SECRET);
      expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(SECRET);
    });

    it('W03 AS-40: the secret is never logged', async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
      renderPanel(needsAction());
      await waitFor(() => expect(provider.confirmAction).toHaveBeenCalled());
      await screen.findByText('Payment is being processed…');
      expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain(SECRET);
    });

    it('W03 AS-40: closing the frame shows "Your bank needs you to confirm this payment." with Continue verification, which opens it again', async () => {
      provider.confirmAction.mockResolvedValueOnce({ ok: false, abandoned: true });
      renderPanel(needsAction());
      expect(await screen.findByText('Your bank needs you to confirm this payment.')).toBeInTheDocument();
      expect(queryPayButton()).not.toBeInTheDocument();
      const again = await screen.findByRole('button', { name: 'Continue verification' });
      await waitFor(() => expect(again).toBeEnabled());

      await userEvent.click(again);
      await waitFor(() => expect(provider.confirmAction).toHaveBeenCalledTimes(2));
      expect(provider.confirmAction).toHaveBeenLastCalledWith(SECRET);
      expect(await screen.findByText('Payment is being processed…')).toBeInTheDocument();
    });

    it('W03 AS-40: after the frame is completed the flow goes on like a normal payment (completed -> confirming -> success)', async () => {
      renderPanel(needsAction());
      await screen.findByText('Payment is being processed…');
      expect(provider.confirmAction).toHaveBeenCalledTimes(1); // not reopened while the payment is still reported as needing action

      backend.page = aggregate({ payment: payment({ status: 'COMPLETED', version: 2 }) });
      emitPayment('COMPLETED');
      expect(await screen.findByText('Payment received. Confirming your order…')).toBeInTheDocument();
    });

    it('W03 AS-40: a payment id that no longer needs action opens no frame', async () => {
      backend.secret = SECRET;
      renderPanel(aggregate({ payment: payment() }));
      await screen.findByText('Payment is being processed…');
      expect(provider.confirmAction).not.toHaveBeenCalled();
    });
  });

  describe('pay request problems (AS-44)', () => {
    const rejectWith = (response: () => Response) => {
      answerIntent = response;
    };
    const conflict = (code: string, extra: Record<string, unknown> = {}) => () =>
      HttpResponse.json(
        { type: `https://marketplace.example/problems/${code}`, title: 'x', status: 409, detail: 'x', instance: '/x', code, requestId: 'req-test-1', ...extra },
        { status: 409, headers: { 'content-type': 'application/problem+json' } },
      );

    it('W03 AS-44: 409 order_not_payable re-reads the order and shows what it reports: cancelled', async () => {
      rejectWith(conflict('order_not_payable', { reason: 'order_cancelled' }));
      renderPanel();
      await screen.findByRole('group', { name: 'Card details' });
      backend.page = aggregate({ status: 'CANCELLED', reason: 'user_cancelled' });
      await pay();
      expect(await screen.findByRole('heading', { name: 'This order was cancelled' })).toBeInTheDocument();
      expect(screen.getByText('You cancelled this order.')).toBeInTheDocument();
    });

    it('W03 AS-44: 409 order_not_payable with a paid order moves to the success page', async () => {
      rejectWith(conflict('order_not_payable', { reason: 'order_paid' }));
      renderPanel();
      await screen.findByRole('group', { name: 'Card details' });
      backend.page = aggregate({ status: 'PAID', payment: payment({ status: 'COMPLETED' }) });
      await pay();
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/checkout/success/${ORDER_ID}`));
    });

    it('W03 AS-44: 409 order_not_payable for an ended hold shows the hold_expired cancellation', async () => {
      rejectWith(conflict('order_not_payable', { reason: 'hold_expired' }));
      renderPanel();
      await screen.findByRole('group', { name: 'Card details' });
      backend.page = aggregate({ status: 'CANCELLED', reason: 'hold_expired' });
      await pay();
      expect(await screen.findByText('The reservation ended before payment.')).toBeInTheDocument();
    });

    it('W03 AS-44: 409 payment_already_exists follows that payment instead of showing an error', async () => {
      backend.page = aggregate({ payment: payment() });
      rejectWith(conflict('payment_already_exists', { existingPaymentId: PAYMENT_ID }));
      renderPanel(aggregate());
      await pay();
      expect(await screen.findByText('Payment is being processed…')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await waitFor(() => expect(calls.paymentReads).toBeGreaterThan(0));
    });

    it('W03 AS-44: 404 order_not_found is retried with the same key every 2 s up to 3 times, then "We couldn\'t start the payment yet. Try again." with Pay enabled', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      rejectWith(() => problemResponse(404, 'order_not_found'));
      renderPanel();
      await screen.findByRole('group', { name: 'Card details' });
      act(() => fields().complete());
      fireEvent.click(payButton());
      await waitFor(() => expect(calls.intents).toHaveLength(1));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      await advance(2_000);
      await waitFor(() => expect(calls.intents).toHaveLength(2));
      await advance(2_000);
      await waitFor(() => expect(calls.intents).toHaveLength(3));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await advance(2_000);
      await waitFor(() => expect(calls.intents).toHaveLength(4));

      expect(await screen.findByText("We couldn't start the payment yet. Try again.")).toBeInTheDocument();
      expect(new Set(calls.intents.map((call) => call.key)).size).toBe(1);
      await waitFor(() => expect(payButton()).toBeEnabled());
      await advance(10_000);
      expect(calls.intents).toHaveLength(4);
    });

    it('W03 AS-44: a lagging 404 that clears on the third try goes on to processing without any error', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      answerIntent = (n) => (n < 3 ? problemResponse(404, 'order_not_found') : accepted());
      renderPanel();
      await screen.findByRole('group', { name: 'Card details' });
      act(() => fields().complete());
      fireEvent.click(payButton());
      await waitFor(() => expect(calls.intents).toHaveLength(1));
      await advance(2_000);
      await waitFor(() => expect(calls.intents).toHaveLength(2));
      await advance(2_000);
      expect(await screen.findByText('Payment is being processed…')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(new Set(calls.intents.map((call) => call.key)).size).toBe(1);
    });

    it.each([
      [422, 'amount_out_of_range'],
      [422, 'currency_unsupported'],
      [422, 'idempotency_key_reuse'],
      [422, 'idempotency_key_invalid'],
      [400, 'validation_failed'],
    ])('W03 AS-44: %i %s shows the generic alert, never the server text, and the form stays usable with a new key', async (status, code) => {
      let first = true;
      answerIntent = () => {
        if (first) {
          first = false;
          return problemResponse(status, code);
        }
        return accepted();
      };
      renderPanel();
      await pay();
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Something went wrong. Try again.');
      expect(alert).not.toHaveTextContent('Server title');
      expect(alert).not.toHaveTextContent('Server detail');
      expect(payButton()).toBeEnabled();

      await userEvent.click(payButton());
      await screen.findByText('Payment is being processed…');
      expect(calls.intents).toHaveLength(2);
      expect(calls.intents[1].key).not.toBe(calls.intents[0].key);
    });

    it('W03 AS-44: a 5xx shows the generic alert with its reference and hides the detail', async () => {
      rejectWith(() => problemResponse(500, 'internal_error', { requestId: 'req-500-xyz' }));
      renderPanel();
      await pay();
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Something went wrong. Try again.');
      expect(alert).toHaveTextContent('req-500-xyz');
      expect(alert).not.toHaveTextContent('Server detail');
      expect(payButton()).toBeEnabled();
    });

    it('W03 AS-44: 409 idempotency_in_flight is retried by itself with the same key after Retry-After, at most 5 times, then says so and re-enables Pay', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      rejectWith(() => problemResponse(409, 'idempotency_in_flight', { retryAfter: 1 }));
      renderPanel();
      await screen.findByRole('group', { name: 'Card details' });
      act(() => fields().complete());
      fireEvent.click(payButton());
      for (let n = 1; n <= 6; n += 1) {
        await waitFor(() => expect(calls.intents).toHaveLength(n));
        await advance(1_000);
      }
      expect(await screen.findByText("We're still processing your payment. Try again in a moment.")).toBeInTheDocument();
      expect(new Set(calls.intents.map((call) => call.key)).size).toBe(1);
      await advance(10_000);
      expect(calls.intents).toHaveLength(6);
      await waitFor(() => expect(payButton()).toBeEnabled());
    });

    it('W03 AS-44: 429 shows "Too many attempts. Try again in {wait}.", disables Pay until the time has passed, then enables it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      rejectWith(() => problemResponse(429, 'rate_limited', { retryAfter: 3 }));
      renderPanel();
      await screen.findByRole('group', { name: 'Card details' });
      act(() => fields().complete());
      fireEvent.click(payButton());
      expect(await screen.findByText(/Too many attempts\. Try again in \d+ seconds?\./)).toBeInTheDocument();
      expect(payButton()).toBeDisabled();
      await advance(3_500);
      await waitFor(() => expect(payButton()).toBeEnabled());
      expect(screen.queryByText(/Too many attempts/)).not.toBeInTheDocument();
    });

    it('W03 AS-44: a 401 runs the session-ended flow once', async () => {
      const ended = vi.fn();
      setSessionEndHandler(ended);
      rejectWith(() => problemResponse(401, 'session_expired'));
      renderPanel();
      await pay();
      await waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    });
  });

  describe('loading and failing reads', () => {
    it('W03 AS-35: while the order is read the panel is a status; a failed read says so with Try again', async () => {
      server.use(http.get(`${origin}/api/bff/orders/:id`, () => problemResponse(503, 'unavailable', { requestId: 'req-503' })));
      client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(queryKeys.auth.session(), { id: USER, email: 'a@b.co', role: 'USER' });
      render(
        <QueryClientProvider client={client}>
          <PayPanel orderId={ORDER_ID} />
        </QueryClientProvider>,
      );
      expect(screen.getByRole('status')).toHaveTextContent('Loading payment…');
      // The read hook retries a 5xx once (after its back-off) before giving up.
      const alert = await screen.findByRole('alert', {}, { timeout: 5000 });
      expect(within(alert).getByText("We couldn't load your payment.")).toBeInTheDocument();
      expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });
  });
});
