'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PaymentStatusValue } from '@marketplace-sandbox/contracts';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { useOnline } from '@/hooks/use-online';
import { usePayFlow } from '@/hooks/use-pay-flow';
import { useStreamFallback, useUserEvents } from '@/hooks/use-user-stream';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';
import { useOrder, type OrderPageResponse } from '@/lib/api/orders';
import { createPaymentIntent, existingPaymentId, readClientSecret, usePayment } from '@/lib/api/payments';
import { endSession } from '@/lib/auth/session-ended';
import { afterPayResult, attemptForPay, type PayAttempt } from '@/lib/checkout/attempt';
import { clearPayAttempt, loadPayAttempt, savePayAttempt } from '@/lib/checkout/attempt-store';
import { trackCheckoutStep } from '@/lib/checkout/events';
import { orderSummaryGroups, orderUnitCount } from '@/lib/checkout/order-groups';
import type { PayPhase, PayServerData } from '@/lib/checkout/pay-flow';
import { isConfirmed } from '@/lib/checkout/status';
import { queryKeys } from '@/lib/query-keys';
import { successHref } from '@/lib/routes';
import { formatMoney } from '@/lib/utils';
import { OrderSummary } from './order-summary';
import { confirmPaymentAction } from './payment-fields';
import { PayForm } from './pay-form';
import { PaySkeleton } from './page-skeletons';
import { PaymentStatus, type StatusPanel } from './payment-status';
import { CheckoutProgress } from './progress';
import { ReservationTimer } from './reservation-timer';
import { StreamBanner } from './stream-banner';

/** AS-44: `404 order_not_found` on the pay request means the payments side has not seen the reservation yet. */
const LAG_RETRIES = 3;
const LAG_WAIT_MS = 2000;
/** AS-44 / AS-22: `409 idempotency_in_flight` is retried by itself with the same key. */
const IN_FLIGHT_RETRIES = 5;
const DEFAULT_RATE_LIMIT_SECONDS = 5;

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const IN_PROGRESS: ReadonlySet<PayPhase> = new Set<PayPhase>(['tokenizing', 'submitting', 'processing', 'actionRequired', 'confirming', 'unknown']);
const POLLED: ReadonlySet<PayPhase> = new Set<PayPhase>(['submitting', 'processing', 'actionRequired', 'confirming', 'unknown']);

function Heading() {
  return <h1 className="text-2xl font-bold tracking-tight">Pay for your order</h1>;
}

/** "Order summary, 2 items, €39.98": a disclosure on a phone (collapsed), open from 1024 px where the summary is a side card. */
function SummaryDisclosure({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const sync = () => setOpen(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="rounded-xl border bg-card p-4">
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">{summary}</summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}

/**
 * The pay step (W03 US3, AS-35..AS-47). Reads the order aggregate (first read handed over by the server page), follows
 * the payment by id, and shows what the server reports: the card form, a status panel, or the ended-order panel. The
 * phase is the closed reducer of `lib/checkout/pay-flow.ts`; live updates come from the shared stream with the polling
 * fallback of AS-39. The provider's `clientSecret` is read for one call and kept in memory only.
 */
export function PayPanel({ orderId }: { orderId: string }) {
  const order = useOrder(orderId);

  if (order.isPending) return <PaySkeleton />;
  if (!order.data) {
    const problem = problemFromError(order.error);
    const copy = problemCopy('pay', problem, { operation: 'read' });
    return (
      <div className="space-y-6">
        <Heading />
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          <p>We couldn&apos;t load your payment.</p>
          {copy.reference && <p className="mt-1 text-xs">{copy.reference}</p>}
          <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11 sm:min-h-7" onClick={() => void order.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  return <PayStep orderId={orderId} page={order.data} />;
}

/** The part of a payment the step reads, whether it came from the order aggregate or from the payment itself. */
type Followed = { id: string; status: PaymentStatusValue; requiresAction: boolean; failureCode: string | null; version: number };

function PayStep({ orderId, page }: { orderId: string; page: OrderPageResponse }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const online = useOnline();
  const { order } = page;

  // --- the payment, followed by id ---------------------------------------------------------------------------------------
  const [followId, setFollowId] = useState<string | null>(null);
  const paymentId = followId ?? page.payment?.id;
  const paymentQuery = usePayment(paymentId);
  const payment: Followed | null = useMemo(() => {
    const candidates = [page.payment, paymentQuery.data].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry) && entry?.id === paymentId);
    return candidates.reduce<Followed | null>((best, entry) => (best && best.version > entry.version ? best : entry), null);
  }, [page.payment, paymentQuery.data, paymentId]);

  // --- phase ---------------------------------------------------------------------------------------------------------------
  const [actionDoneVersion, setActionDoneVersion] = useState<number | null>(null);
  const paymentStatus = payment?.status;
  const paymentVersion = payment?.version;
  const needsAction = Boolean(payment?.requiresAction) && paymentVersion !== actionDoneVersion;
  const hasPayment = payment !== null;
  const serverData: PayServerData = useMemo(
    () => ({
      payment: hasPayment && paymentStatus ? { status: paymentStatus, requiresAction: needsAction } : null,
      orderStatus: order.status,
    }),
    [hasPayment, paymentStatus, needsAction, order.status],
  );
  const flow = usePayFlow(serverData);
  const { phase, view, send, sync, slowConfirming } = flow;
  useEffect(() => sync(serverData), [sync, serverData]);

  const confirmed = isConfirmed(order.status);
  const ended = view.kind === 'order-ended';

  // --- reads, stream, polling --------------------------------------------------------------------------------------------
  const refetchAll = useCallback(async () => {
    await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(orderId) }),
      paymentId ? queryClient.invalidateQueries({ queryKey: queryKeys.payments.detail(paymentId) }) : Promise.resolve(),
    ]);
  }, [queryClient, orderId, paymentId]);

  useUserEvents({
    onEvent: (event) => {
      if (event.type === 'payment.status' && event.data.orderId === orderId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(orderId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.payments.detail(event.data.paymentId) });
      } else if (event.type === 'order.status' && event.data.orderId === orderId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(orderId) });
      }
    },
    onResync: () => void refetchAll(),
  });
  const waiting = !ended && !confirmed && (order.status === 'PENDING' || POLLED.has(phase));
  const fallback = useStreamFallback(refetchAll, waiting);

  // --- analytics, redirect, attempt clean-up -----------------------------------------------------------------------------
  const units = orderUnitCount(order);
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current) return;
    reported.current = true;
    trackCheckoutStep({ step: 'pay', items: units, orderId });
  }, [units, orderId]);

  const redirected = useRef(false);
  useEffect(() => {
    if (!confirmed || redirected.current) return;
    redirected.current = true;
    clearPayAttempt(orderId);
    router.replace(successHref(orderId));
  }, [confirmed, orderId, router]);

  useEffect(() => {
    if (phase === 'failed' || ended) clearPayAttempt(orderId);
  }, [phase, ended, orderId]);

  // --- paying ------------------------------------------------------------------------------------------------------------
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const [problem, setProblem] = useState<Problem | null>(null);
  const [problemSeq, setProblemSeq] = useState(0);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (problemSeq > 0) alertRef.current?.focus();
  }, [problemSeq]);

  // AS-44 (429): the countdown ticks once a second; Pay is enabled again when the time has passed.
  useEffect(() => {
    if (blockedUntil === null) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= blockedUntil) {
        setBlockedUntil(null);
        setProblem(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [blockedUntil]);

  const follow = useCallback(
    (id: string) => {
      setFollowId(id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(orderId) });
    },
    [queryClient, orderId],
  );

  const reject = useCallback(
    (failure: Problem) => {
      send('SUBMIT_REJECTED');
      setProblem(failure);
      setProblemSeq((count) => count + 1);
      if (failure.status === 401) endSession();
      if (failure.status === 429 || failure.code === 'rate_limited') {
        const time = Date.now();
        setNow(time);
        setBlockedUntil(time + Math.max(1, failure.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_SECONDS) * 1000);
      }
      // The server decides what the order is now (AS-44): paid, cancelled or expired replace the form.
      if (failure.code === 'order_not_payable') void queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(orderId) });
    },
    [send, queryClient, orderId],
  );

  const submit = useCallback(
    async (attempt: PayAttempt) => {
      let lagRetries = 0;
      let inFlightRetries = 0;
      for (;;) {
        try {
          const accepted = await createPaymentIntent({ orderId, paymentMethodId: attempt.paymentMethodId, key: attempt.key });
          if (!alive.current) return;
          follow(accepted.paymentId);
          send('ACCEPTED');
          return;
        } catch (error) {
          if (!alive.current) return;
          const failure = problemFromError(error);
          if (!afterPayResult(attempt, { ok: false, status: failure.status, code: failure.code })) clearPayAttempt(orderId);
          const existing = failure.code === 'payment_already_exists' ? existingPaymentId(error) : undefined;
          if (existing) {
            follow(existing);
            send('ACCEPTED');
            return;
          }
          if (failure.code === 'order_not_found' && lagRetries < LAG_RETRIES) {
            lagRetries += 1;
            await sleep(LAG_WAIT_MS);
            continue;
          }
          if (failure.code === 'idempotency_in_flight' && inFlightRetries < IN_FLIGHT_RETRIES) {
            inFlightRetries += 1;
            await sleep(Math.max(1, failure.retryAfterSeconds ?? 1) * 1000);
            continue;
          }
          reject(failure);
          return;
        }
      }
    },
    [orderId, follow, send, reject],
  );

  const busy = useRef(false);
  const onPress = useCallback(() => {
    setProblem(null);
    setBlockedUntil(null);
    send('PRESS_PAY');
  }, [send]);
  const onTokenFailed = useCallback(() => send('TOKEN_FAILED'), [send]);
  const onToken = useCallback(
    (paymentMethodId: string) => {
      if (busy.current) return;
      busy.current = true;
      const attempt = attemptForPay(loadPayAttempt(orderId), { paymentMethodId, now: Date.now() });
      savePayAttempt(orderId, attempt);
      send('TOKEN_READY');
      void submit(attempt).finally(() => {
        busy.current = false;
      });
    },
    [orderId, send, submit],
  );

  // --- 3-D Secure (AS-40) ------------------------------------------------------------------------------------------------
  const frameBusy = useRef(false);
  const [opening, setOpening] = useState(false);
  const openedFor = useRef<number | null>(null);
  const openFrame = useCallback(
    async (id: string, version: number) => {
      if (frameBusy.current) return;
      frameBusy.current = true;
      setOpening(true);
      try {
        const secret = await readClientSecret(id);
        if (!alive.current) return;
        if (secret === null) {
          void refetchAll();
          return;
        }
        const result = await confirmPaymentAction(secret);
        if (!alive.current) return;
        if (result.ok) {
          setActionDoneVersion(version);
          send('ACTION_DONE');
          void refetchAll();
        }
      } catch {
        // Treated like a closed frame: the panel offers Continue verification.
      } finally {
        frameBusy.current = false;
        if (alive.current) setOpening(false);
      }
    },
    [refetchAll, send],
  );
  useEffect(() => {
    if (phase !== 'actionRequired' || paymentId === undefined || paymentVersion === undefined) return;
    if (openedFor.current === paymentVersion) return;
    openedFor.current = paymentVersion;
    void openFrame(paymentId, paymentVersion);
  }, [phase, paymentId, paymentVersion, openFrame]);

  // --- what to show --------------------------------------------------------------------------------------------------------
  const items = useMemo(() => order.items.map((item) => ({ productId: item.productId, title: item.title, quantity: item.quantity })), [order.items]);
  const total = formatMoney(order.totalMinor, order.currency);
  const blockedSeconds = blockedUntil === null ? null : Math.max(1, Math.ceil((blockedUntil - now) / 1000));

  let panel: StatusPanel | null = null;
  if (view.kind === 'order-ended') {
    const cause = [...order.timeline].reverse().find((entry) => entry.status === 'CANCELLED')?.reason ?? null;
    panel = { kind: 'ended', reason: view.reason, cause, paymentArrivedLate: view.paymentArrivedLate, items };
  } else if (confirmed || phase === 'completed') {
    panel = { kind: 'redirecting' };
  } else if (order.status === 'PENDING') {
    panel = { kind: 'reserving' };
  } else {
    switch (phase) {
      case 'processing':
        panel = { kind: 'processing' };
        break;
      case 'confirming':
        panel = { kind: 'confirming', slow: slowConfirming };
        break;
      case 'unknown':
        panel = { kind: 'unknown' };
        break;
      case 'actionRequired':
        panel = { kind: 'action', opening, onContinue: () => paymentId !== undefined && paymentVersion !== undefined && void openFrame(paymentId, paymentVersion) };
        break;
      case 'failed':
        panel = { kind: 'failed', failureCode: payment?.failureCode ?? null, orderId, items };
        break;
      case 'expired':
        panel = { kind: 'expired' };
        break;
      default:
    }
  }

  // Focus moves to the panel heading when a panel replaces the form, not when the page opens on a panel.
  const sawForm = useRef(false);
  const showingForm = panel === null;
  const focusPanel = sawForm.current;
  useEffect(() => {
    if (showingForm) sawForm.current = true;
  }, [showingForm]);

  const timerVisible = !ended && !confirmed && order.status === 'RESERVED' && phase !== 'failed' && phase !== 'completed' && phase !== 'expired';
  const blocked = !online || blockedUntil !== null;

  const alert = problem ? (
    problem.status === 429 || problem.code === 'rate_limited' ? (
      <div ref={alertRef} role="alert" tabIndex={-1} className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 outline-none dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
        <p aria-live="off">{problemCopy('pay', { ...problem, retryAfterSeconds: blockedSeconds ?? problem.retryAfterSeconds }).text}</p>
      </div>
    ) : (
      <ProblemAlert ref={alertRef} problem={problem} surface="pay" />
    )
  ) : null;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Heading />
        <CheckoutProgress current="pay" />
      </div>

      <StreamBanner />
      {timerVisible && <ReservationTimer reservedUntil={order.reservedUntil} paymentInProgress={IN_PROGRESS.has(phase)} onExpired={() => { send('RESERVATION_ENDED'); void queryClient.invalidateQueries({ queryKey: queryKeys.orders.detail(orderId) }); }} />}
      {!online && showingForm && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100">
          You&apos;re offline. Reconnect to pay.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div className="space-y-4">
          {alert}
          {panel ? (
            <PaymentStatus panel={panel} focus={focusPanel} stalled={fallback.state === 'stopped' && waiting ? { onCheckAgain: fallback.checkAgain } : undefined} />
          ) : (
            <PayForm label={total} pending={phase !== 'idle'} blocked={blocked} onPress={onPress} onToken={onToken} onTokenFailed={onTokenFailed} />
          )}
        </div>
        <aside className="max-lg:order-first lg:sticky lg:top-24">
          <SummaryDisclosure summary={`Order summary, ${units} ${units === 1 ? 'item' : 'items'}, ${total}`}>
            <OrderSummary groups={orderSummaryGroups(order)} totals={[{ amountMinor: order.totalMinor, currency: order.currency }]} totalLabel="Total" />
          </SummaryDisclosure>
        </aside>
      </div>
    </div>
  );
}
