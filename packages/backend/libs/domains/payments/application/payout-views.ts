import type {
  AdminPayoutView,
  PayoutView,
} from '@marketplace-sandbox/contracts';
import { maskDestination } from '../domain/destination';
import type { PayoutRecord } from '../domain/payout-ports';
import { toPublicStatus } from '../domain/payout-state';

/** The seller's view of a payout: public statuses, no destination, no attempts, no raw failure text. */
export function toPayoutView(p: PayoutRecord): PayoutView {
  return {
    id: p.id,
    shopId: p.shopId,
    periodStart: p.periodStart,
    amountMinor: p.amountMinor,
    reserveHeldMinor: p.reserveHeldMinor,
    currency: 'EUR',
    status: toPublicStatus(p.status),
    transferRef: p.transferRef,
    failureCode: p.failureCode,
    createdAt: p.createdAt.toISOString(),
    paidAt: p.paidAt ? p.paidAt.toISOString() : null,
  };
}

/** The operator's view: internal status, attempts, the sanitized reason and the destination masked. */
export function toAdminPayoutView(p: PayoutRecord): AdminPayoutView {
  return {
    ...toPayoutView(p),
    status: p.status,
    attempts: p.attempts,
    failureReason: p.failureReason ? p.failureReason.slice(0, 200) : null,
    destination: p.destinationSnapshot
      ? maskDestination(p.destinationSnapshot)
      : null,
  };
}
