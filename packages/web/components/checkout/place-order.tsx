'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { placeOrder } from '@/app/checkout/actions';
import { Button } from '@/components/ui/button';
import { useSetCartLine } from '@/lib/api/cart';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { endSession } from '@/lib/auth/session-ended';
import { acceptNewTotal, afterOrderResult, attemptForPress, cartFingerprint, type OrderAttempt } from '@/lib/checkout/attempt';
import { clearOrderAttempt, loadOrderAttempt, saveOrderAttempt } from '@/lib/checkout/attempt-store';
import type { CheckoutProblem, PlaceOrderResult } from '@/lib/checkout/checkout-problem';
import { payHref } from '@/lib/routes';
import { queryKeys } from '@/lib/query-keys';
import type { CartDto } from '@marketplace-sandbox/contracts';

/** AS-22: the same key is retried automatically at most this many times after the first answer. */
export const MAX_IN_FLIGHT_RETRIES = 5;
/** AS-22: never sooner than this, whatever `Retry-After` says. */
const MIN_RETRY_SECONDS = 1;
/** AS-29: the wait when `429` carries no usable `Retry-After`. */
const DEFAULT_RATE_LIMIT_SECONDS = 5;

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** A Server Function call that throws (the network, or the server) is the "temporarily unavailable" form: nothing is known, the key is kept. */
async function callPlaceOrder(input: { key: string; expectedTotalMinor: number }): Promise<PlaceOrderResult> {
  try {
    return await placeOrder(input);
  } catch {
    return { ok: false, problem: { status: 0, errors: [] } };
  }
}

export type PlaceOrderInput = {
  /** Every line of the cart (available or not): the attempt is bound to this content. */
  lines: readonly { productId: string; quantity: number }[];
  /** The estimated total the buyer is looking at (FR-012). */
  expectedTotalMinor: number;
  online: boolean;
};

/**
 * The Place order flow of the review (W03 AS-17..AS-32): one request at a time, the attempt/key lifecycle of
 * `lib/checkout/attempt.ts` kept in the tab's session storage, the automatic retry of `409 idempotency_in_flight` as a loop
 * in the browser (Server Functions run one at a time, so the wait cannot live inside the function), and the state each
 * problem needs. Rendering is the caller's: `ProblemAlerts` for the alert, `PlaceOrderButton` for the button.
 */
export function usePlaceOrder({ lines, expectedTotalMinor, online }: PlaceOrderInput) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const setCartLine = useSetCartLine();

  const [pending, setPending] = useState(false);
  const [placed, setPlaced] = useState(false);
  const [problem, setProblem] = useState<CheckoutProblem | null>(null);
  const [problemSeq, setProblemSeq] = useState(0);
  const [cartProblem, setCartProblem] = useState<Problem | null>(null);
  const [cartEmptied, setCartEmptied] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [rateLimitEnded, setRateLimitEnded] = useState(false);

  const busy = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fingerprint = useMemo(() => cartFingerprint(lines), [lines]);

  // AS-29: the countdown ticks once a second; the button is enabled again when the time has passed.
  useEffect(() => {
    if (blockedUntil === null) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= blockedUntil) {
        setBlockedUntil(null);
        setProblem(null);
        setRateLimitEnded(true);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [blockedUntil]);

  const succeed = useCallback(
    (orderId: string) => {
      setPlaced(true);
      // The cart is empty now: the badge shows it at once; the page read is marked stale and read again when next shown.
      queryClient.setQueryData<CartDto>(queryKeys.cart.lines(), (current) => (current ? { ...current, lines: [] } : current));
      void queryClient.invalidateQueries({ queryKey: queryKeys.cart.all, refetchType: 'none' });
      router.push(payHref(orderId));
    },
    [queryClient, router],
  );

  const fail = useCallback(
    (failure: CheckoutProblem) => {
      busy.current = false;
      setPending(false);
      setProblem(failure);
      setProblemSeq((count) => count + 1);
      if (failure.code === 'cart_empty') {
        setCartEmptied(true);
        void queryClient.invalidateQueries({ queryKey: queryKeys.cart.all });
      }
      if (failure.status === 401) endSession();
      if (failure.status === 429 || failure.code === 'rate_limited') {
        const seconds = Math.max(MIN_RETRY_SECONDS, failure.retryAfter ?? DEFAULT_RATE_LIMIT_SECONDS);
        const time = Date.now();
        setNow(time);
        setBlockedUntil(time + seconds * 1000);
      }
    },
    [queryClient],
  );

  const send = useCallback(
    async (attempt: OrderAttempt) => {
      for (let retries = 0; ; ) {
        const result = await callPlaceOrder({ key: attempt.key, expectedTotalMinor: attempt.expectedTotalMinor });
        if (!alive.current) return;
        const kept = afterOrderResult(attempt, result.ok ? { ok: true } : { ok: false, status: result.problem.status, code: result.problem.code });
        if (kept) saveOrderAttempt(kept);
        else clearOrderAttempt();
        if (result.ok) {
          succeed(result.orderId);
          return;
        }
        if (result.problem.code === 'idempotency_in_flight' && retries < MAX_IN_FLIGHT_RETRIES) {
          retries += 1;
          await sleep(Math.max(MIN_RETRY_SECONDS, result.problem.retryAfter ?? MIN_RETRY_SECONDS) * 1000);
          if (!alive.current) return;
          continue;
        }
        fail(result.problem);
        return;
      }
    },
    [fail, succeed],
  );

  const start = useCallback(
    (attempt: OrderAttempt) => {
      busy.current = true;
      setPending(true);
      setProblem(null);
      setCartProblem(null);
      setBlockedUntil(null);
      setRateLimitEnded(false);
      saveOrderAttempt(attempt);
      void send(attempt);
    },
    [send],
  );

  const blocked = blockedUntil !== null || removing || !online;

  /** AS-17, AS-18: a press while a request is pending (or the button is disabled) is ignored. */
  const press = useCallback(() => {
    if (busy.current || blocked) return;
    start(attemptForPress(loadOrderAttempt(), { fingerprint, expectedTotalMinor, now: Date.now() }));
  }, [blocked, expectedTotalMinor, fingerprint, start]);

  /** AS-23: the buyer accepts the new total; the key is kept (no order existed) and only the total changes. */
  const accept = useCallback(() => {
    if (busy.current || blocked || problem?.code !== 'price_changed' || problem.currentTotalMinor === undefined) return;
    const base = attemptForPress(loadOrderAttempt(), { fingerprint, expectedTotalMinor, now: Date.now() });
    start(acceptNewTotal(base, problem.currentTotalMinor));
  }, [blocked, expectedTotalMinor, fingerprint, problem, start]);

  /** AS-25: one write per named line, then the cart is read again by the write queue; Place order is disabled meanwhile. */
  const removeUnavailable = useCallback(
    async (productIds: readonly string[]) => {
      if (removing) return;
      setRemoving(true);
      setCartProblem(null);
      const results = await Promise.allSettled(productIds.map((productId) => setCartLine(productId, 0)));
      if (!alive.current) return;
      setRemoving(false);
      const failed = results.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
      if (failed) setCartProblem(problemFromError(failed.reason));
      else setProblem(null);
    },
    [removing, setCartLine],
  );

  const blockedSeconds = blockedUntil === null ? null : Math.max(1, Math.ceil((blockedUntil - now) / 1000));

  return {
    pending: pending || placed,
    problem,
    problemSeq,
    cartProblem,
    cartEmptied,
    removing,
    blockedSeconds,
    rateLimitEnded,
    disabled: pending || placed || blocked,
    press,
    accept,
    removeUnavailable,
  };
}

/** **Place order** (AS-17): "Placing order…" and `aria-busy` while a request is pending; disabled when it cannot be pressed. */
export function PlaceOrderButton({ pending, disabled, onPress }: { pending: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Button type="button" size="lg" className="min-h-11 w-full text-base" disabled={disabled} aria-busy={pending} onClick={onPress}>
      {pending ? 'Placing order…' : 'Place order'}
    </Button>
  );
}
