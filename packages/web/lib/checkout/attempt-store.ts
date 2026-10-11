import { subscribeAuth } from '@/lib/auth/session-sync';
import { ATTEMPT_MAX_AGE_MS, parseOrderAttempt, parsePayAttempt, type OrderAttempt, type PayAttempt } from './attempt';

/**
 * The tab's copy of the order and pay attempts (W03 FR-021, AS-20, AS-47). The only module that touches `sessionStorage`,
 * and it lives outside `lib/api`. The stored value is a random key, the expected total and a timestamp: never a credential.
 * Both keys are listed in `lib/browser-storage-keys.ts` and on the privacy page. Storage that throws acts like no storage.
 */
export const CHECKOUT_ATTEMPT_KEY = 'w03.attempt.checkout';
const PAY_PREFIX = 'w03.attempt.pay:';
export const payAttemptKey = (orderId: string): string => `${PAY_PREFIX}${orderId}`;

function store(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    store()?.setItem(key, value);
  } catch {
    // Quota or private mode: the attempt just does not survive a reload.
  }
}

function remove(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    // Nothing to do.
  }
}

const stale = (createdAt: number, now: number) => now - createdAt > ATTEMPT_MAX_AGE_MS;

export function loadOrderAttempt(now: number = Date.now()): OrderAttempt | null {
  const raw = read(CHECKOUT_ATTEMPT_KEY);
  if (raw === null) return null;
  const attempt = parseOrderAttempt(raw);
  if (!attempt || stale(attempt.createdAt, now)) {
    remove(CHECKOUT_ATTEMPT_KEY);
    return null;
  }
  return attempt;
}

export function saveOrderAttempt(attempt: OrderAttempt): void {
  write(CHECKOUT_ATTEMPT_KEY, JSON.stringify(attempt));
}

export function clearOrderAttempt(): void {
  remove(CHECKOUT_ATTEMPT_KEY);
}

export function loadPayAttempt(orderId: string, now: number = Date.now()): PayAttempt | null {
  const key = payAttemptKey(orderId);
  const raw = read(key);
  if (raw === null) return null;
  const attempt = parsePayAttempt(raw);
  if (!attempt || stale(attempt.createdAt, now)) {
    remove(key);
    return null;
  }
  return attempt;
}

export function savePayAttempt(orderId: string, attempt: PayAttempt): void {
  write(payAttemptKey(orderId), JSON.stringify(attempt));
}

export function clearPayAttempt(orderId: string): void {
  remove(payAttemptKey(orderId));
}

/** Sign-out: deletes the order attempt and every pay attempt of this tab. */
export function clearAllAttempts(): void {
  try {
    const storage = store();
    if (!storage) return;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key === CHECKOUT_ATTEMPT_KEY || key?.startsWith(PAY_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Nothing to do.
  }
}

/** Listens for the `auth` broadcast and deletes all attempts on "signed-out". Returns the unsubscribe function. */
export function watchAuthForAttempts(): () => void {
  return subscribeAuth((type) => {
    if (type === 'signed-out') clearAllAttempts();
  });
}
