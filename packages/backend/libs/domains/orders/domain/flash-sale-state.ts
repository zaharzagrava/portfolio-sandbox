/**
 * The life of a flash sale and the rule for when it sells (S11 FR-006, FR-007, FR-032; data-model §5). Pure: the
 * clock is passed in, and the application applies the result with a conditional update.
 *
 *   SCHEDULED ──load──▶ LOADED ──end──▶ ENDED ──reconcile──▶ RECONCILED
 *       │  ╲                │
 *       │   ╲─fail──▶ START_FAILED   (terminal)
 *       └─cancel─▶ CANCELLED ◀─cancel (only before startsAt)
 */

export const FLASH_SALE_STATUSES = [
  'SCHEDULED',
  'LOADED',
  'ENDED',
  'RECONCILED',
  'CANCELLED',
  'START_FAILED',
] as const;
export type FlashSaleStatus = (typeof FLASH_SALE_STATUSES)[number];

export const STATUS_REASONS = [
  'insufficient_stock',
  'window_missed',
  'cancelled_by_shop',
  'product_unavailable',
] as const;
export type StatusReason = (typeof STATUS_REASONS)[number];

export type FlashCommand =
  | { type: 'load' }
  | { type: 'fail'; reason: StatusReason }
  | { type: 'cancel' }
  | { type: 'end' }
  | { type: 'reconcile' };

export type SaleWindow = { startsAt: Date; endsAt: Date };

export type FlashTransition =
  | { kind: 'applied'; to: FlashSaleStatus; reason?: StatusReason }
  | { kind: 'already' }
  | { kind: 'illegal' };

const applied = (
  to: FlashSaleStatus,
  reason?: StatusReason,
): FlashTransition => ({ kind: 'applied', to, ...(reason && { reason }) });
const ALREADY: FlashTransition = { kind: 'already' };
const ILLEGAL: FlashTransition = { kind: 'illegal' };

/** The next status for a command, `already` when the sale is there (a repeat is a no-op), `illegal` otherwise. */
export function transition(
  status: FlashSaleStatus,
  command: FlashCommand,
  now: Date,
  sale: SaleWindow,
): FlashTransition {
  switch (command.type) {
    case 'load':
      if (status === 'SCHEDULED') return applied('LOADED');
      return status === 'LOADED' ? ALREADY : ILLEGAL;
    case 'fail':
      if (status === 'SCHEDULED') return applied('START_FAILED', command.reason);
      return status === 'START_FAILED' ? ALREADY : ILLEGAL;
    case 'cancel':
      if (status === 'SCHEDULED') return applied('CANCELLED', 'cancelled_by_shop');
      if (status === 'LOADED')
        return now.getTime() < sale.startsAt.getTime()
          ? applied('CANCELLED', 'cancelled_by_shop')
          : ILLEGAL;
      return status === 'CANCELLED' ? ALREADY : ILLEGAL;
    case 'end':
      if (status === 'LOADED') return applied('ENDED');
      // A sale that never loaded can no longer be sold: its window has passed.
      if (status === 'SCHEDULED') return applied('START_FAILED', 'window_missed');
      return status === 'ENDED' || status === 'RECONCILED' ? ALREADY : ILLEGAL;
    case 'reconcile':
      if (status === 'ENDED') return applied('RECONCILED');
      return status === 'RECONCILED' ? ALREADY : ILLEGAL;
  }
}

/** Selling is allowed only while the sale is loaded and the clock is inside `[startsAt, endsAt)`. */
export function isOpen(
  sale: SaleWindow & { status: FlashSaleStatus },
  now: Date,
): boolean {
  return (
    sale.status === 'LOADED' &&
    sale.startsAt.getTime() <= now.getTime() &&
    now.getTime() < sale.endsAt.getTime()
  );
}

export type PublicSaleState = 'UPCOMING' | 'LIVE' | 'SOLD_OUT' | 'ENDED';

const DAY_MS = 24 * 3_600_000;

/**
 * What the public sees, or `null` when the sale is hidden (cancelled, failed, or scheduled more than 24 h ahead).
 * `remaining` is the approximate count when known; `0` while live means sold out.
 */
export function publicState(
  sale: SaleWindow & { status: FlashSaleStatus },
  now: Date,
  remaining: number | null,
): PublicSaleState | null {
  if (sale.status === 'CANCELLED' || sale.status === 'START_FAILED')
    return null;
  if (
    sale.status === 'ENDED' ||
    sale.status === 'RECONCILED' ||
    now.getTime() >= sale.endsAt.getTime()
  )
    return 'ENDED';
  if (now.getTime() < sale.startsAt.getTime())
    return sale.startsAt.getTime() - now.getTime() > DAY_MS ? null : 'UPCOMING';
  // The window has started: only a loaded sale sells; a sale that missed its load is not live.
  if (sale.status !== 'LOADED') return 'UPCOMING';
  return remaining === 0 ? 'SOLD_OUT' : 'LIVE';
}
