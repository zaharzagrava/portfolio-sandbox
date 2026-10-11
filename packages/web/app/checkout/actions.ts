'use server';

import { z } from 'zod';
import { submitCheckout } from '@/lib/server/checkout.server';
import { readRefCode } from '@/lib/server/ref-code.server';
import { toCheckoutProblem, type PlaceOrderResult } from '@/lib/checkout/checkout-problem';

const inputSchema = z.object({ key: z.string().min(1).max(100), expectedTotalMinor: z.number().int().nonnegative() });

/**
 * Place order (W03 FR-011, AS-34): the one server-side call of `POST /checkout`. Server Functions are reachable by anyone
 * with the address, so the input is validated here and the session is checked again in `submitCheckout` (it refuses without
 * the session cookie). It never throws to the browser: every failure is a typed `{ok: false, problem}` value. The 409
 * `idempotency_in_flight` wait is the caller's loop (Server Functions run one at a time per client), not a sleep here.
 */
export async function placeOrder(input: { key: string; expectedTotalMinor: number }): Promise<PlaceOrderResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, problem: toCheckoutProblem({ status: 400, code: 'validation_failed' }) };
  try {
    const refCode = await readRefCode().catch(() => null);
    const result = await submitCheckout({ key: parsed.data.key, expectedTotalMinor: parsed.data.expectedTotalMinor, refCode });
    if (result.ok) return { ok: true, orderId: result.orderId, replayed: result.replayed };
    return { ok: false, problem: toCheckoutProblem(result) };
  } catch {
    return { ok: false, problem: toCheckoutProblem({ status: 500 }) };
  }
}
