import { z } from 'zod';
import { newIdempotencyKey } from '@/lib/api/idempotency';

/**
 * The key lifecycle of Place order and Pay (W03 AS-19, AS-20, AS-47; data-model "Order attempt"). Pure: no storage and no
 * clock of its own (`now` and `newKey` are inputs), so every row of the lifecycle table is a unit test. The browser copy
 * lives in `attempt-store.ts`. An attempt holds a random key, never a credential.
 */

export const ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type OrderAttempt = {
  key: string;
  expectedTotalMinor: number;
  cartFingerprint: string;
  createdAt: number;
  /** The key is spent (`out_of_stock` is final for a key): the next press makes a new one. */
  final?: true;
};
export type PayAttempt = { key: string; paymentMethodId: string; createdAt: number };

// --- fingerprint ---------------------------------------------------------------------------------------------------------
/** cyrb53: a fast 53-bit string hash. Not cryptographic: it only tells "the cart changed", and hides ids in storage. */
function cyrb53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** A hash of the sorted `productId:quantity` pairs; the same cart in any order gives the same value. */
export function cartFingerprint(lines: readonly { productId: string; quantity: number }[]): string {
  const pairs = lines.map((line) => `${line.productId}:${line.quantity}`).sort();
  return cyrb53(pairs.join('|')).toString(16);
}

// --- order attempts ------------------------------------------------------------------------------------------------------
type Clock = { now: number; newKey?: () => string };

const expired = (createdAt: number, now: number) => now - createdAt > ATTEMPT_MAX_AGE_MS;

/**
 * The attempt to use for a press of **Place order**: the stored one when it is still the same attempt (same cart, not
 * spent, younger than 24 h), otherwise a new one. The expected total is the one the buyer is looking at now.
 */
export function attemptForPress(
  stored: OrderAttempt | null,
  context: { fingerprint: string; expectedTotalMinor: number } & Clock,
): OrderAttempt {
  if (stored && !stored.final && stored.cartFingerprint === context.fingerprint && !expired(stored.createdAt, context.now)) {
    return { ...stored, expectedTotalMinor: context.expectedTotalMinor };
  }
  return {
    key: (context.newKey ?? newIdempotencyKey)(),
    expectedTotalMinor: context.expectedTotalMinor,
    cartFingerprint: context.fingerprint,
    createdAt: context.now,
  };
}

/** `409 price_changed`, then **Accept**: no order existed, so the key is kept and only the total changes. */
export function acceptNewTotal(attempt: OrderAttempt, currentTotalMinor: number): OrderAttempt {
  return { ...attempt, expectedTotalMinor: currentTotalMinor };
}

export type ResultLike = { ok: true } | { ok: false; status: number; code?: string };
export type KeyFate = 'keep' | 'delete' | 'final';

const DELETING_CODES = new Set(['cart_empty', 'product_unavailable', 'mixed_currency']);

/** What an answer of `POST /checkout` does to the stored key (data-model table). */
export function classifyOrderResult(result: ResultLike): KeyFate {
  if (result.ok) return 'delete';
  const { status, code } = result;
  if (code === 'out_of_stock') return 'final';
  if (code && (DELETING_CODES.has(code) || code.startsWith('idempotency_key_'))) return 'delete';
  if (status === 400) return 'delete';
  if (status >= 500 && status !== 503) return 'delete';
  return 'keep';
}

export function afterOrderResult(attempt: OrderAttempt | null, result: ResultLike): OrderAttempt | null {
  if (!attempt) return null;
  const fate = classifyOrderResult(result);
  if (fate === 'delete') return null;
  if (fate === 'final') return { ...attempt, final: true };
  return attempt;
}

// --- pay attempts --------------------------------------------------------------------------------------------------------
/** The attempt for a press of **Pay**: the same key for the same method token (double press, reload, retry), else a new one. */
export function attemptForPay(stored: PayAttempt | null, context: { paymentMethodId: string } & Clock): PayAttempt {
  if (stored && stored.paymentMethodId === context.paymentMethodId && !expired(stored.createdAt, context.now)) return stored;
  return { key: (context.newKey ?? newIdempotencyKey)(), paymentMethodId: context.paymentMethodId, createdAt: context.now };
}

const PAY_DELETING_CODES = new Set(['amount_out_of_range', 'currency_unsupported']);

/** AS-44: key misuse, a refused amount or currency, a 400 and a 5xx (not 503) call for a new attempt; the rest keep the key. */
export function afterPayResult(attempt: PayAttempt | null, result: ResultLike): PayAttempt | null {
  if (!attempt || result.ok) return attempt;
  const { status, code } = result;
  if (code && (PAY_DELETING_CODES.has(code) || code.startsWith('idempotency_key_'))) return null;
  if (status === 400 || (status >= 500 && status !== 503)) return null;
  return attempt;
}

// --- storage format ------------------------------------------------------------------------------------------------------
const orderAttemptSchema = z.object({
  key: z.string().uuid(),
  expectedTotalMinor: z.number().int().nonnegative(),
  cartFingerprint: z.string().min(1).max(64),
  createdAt: z.number().int().nonnegative(),
  final: z.literal(true).optional(),
});
const payAttemptSchema = z.object({
  key: z.string().uuid(),
  paymentMethodId: z.string().min(1).max(200),
  createdAt: z.number().int().nonnegative(),
});

function parseJson<T>(schema: z.ZodType<T>, raw: string | null): T | null {
  if (raw === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const parseOrderAttempt = (raw: string | null): OrderAttempt | null => parseJson<OrderAttempt>(orderAttemptSchema, raw);
export const parsePayAttempt = (raw: string | null): PayAttempt | null => parseJson<PayAttempt>(payAttemptSchema, raw);
