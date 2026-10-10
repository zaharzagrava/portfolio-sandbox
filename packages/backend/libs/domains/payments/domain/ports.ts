import type {
  PaymentCurrency,
  PaymentFailureCode,
} from '@marketplace-sandbox/contracts';
import type { OrderCopy } from './order-copy';
import type { PaymentStatus } from './payment-status';
import type { ProviderResponse } from './provider-outcome';

/** A payment as the domain reads it. Amounts are integer minor units (safe integers, checked at the repository edge). */
export interface PaymentRecord {
  id: string;
  userId: string;
  orderId: string;
  amountMinor: number;
  currency: PaymentCurrency;
  status: PaymentStatus;
  version: number;
  providerRef: string | null;
  chargeAttemptedAt: Date | null;
  chargeAttempts: number;
  requiresAction: boolean;
  clientSecret: string | null;
  paymentMethodToken: string | null;
  failureCode: PaymentFailureCode | null;
  nextResolveAt: Date | null;
  resolveChecks: number;
  unknownSince: Date | null;
  lastStuckAlertAt: Date | null;
  refundRequestedAt: Date | null;
  refundNextAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewPayment {
  id: string;
  userId: string;
  orderId: string;
  amountMinor: number;
  currency: PaymentCurrency;
  paymentMethodToken: string;
  now: Date;
}

/** Fields a move may change besides status/version. Only the keys present are written. */
export interface PaymentPatch {
  providerRef?: string | null;
  failureCode?: PaymentFailureCode | null;
  requiresAction?: boolean;
  clientSecret?: string | null;
  paymentMethodToken?: string | null;
  nextResolveAt?: Date | null;
  resolveChecks?: number;
  unknownSince?: Date | null;
  refundRequestedAt?: Date | null;
  refundNextAt?: Date | null;
}

export interface PaymentMove {
  id: string;
  from: PaymentStatus;
  /** The version the caller read; the update matches only that version. */
  version: number;
  to: PaymentStatus;
  /** 0 for the flag-only move, 1 otherwise. */
  versionStep: 0 | 1;
  patch: PaymentPatch;
  /** `cancel`: the row must not have a charge attempt recorded (unless the customer is the one we wait for). */
  requireUnattempted: boolean;
  now: Date;
}

export interface PaymentRepository {
  /** `ON CONFLICT ("orderId") DO NOTHING`; null when the order already has a payment. */
  insertAccepted(input: NewPayment): Promise<PaymentRecord | null>;
  findById(id: string): Promise<PaymentRecord | null>;
  findByOrderId(orderId: string): Promise<PaymentRecord | null>;
  findByProviderRef(providerRef: string): Promise<PaymentRecord | null>;
  /** Conditional update by id, status and version; null when the row moved on (a lost race). */
  move(move: PaymentMove): Promise<PaymentRecord | null>;
  /** Records the start of a charge attempt (`chargeAttemptedAt IS NULL AND status = 'PENDING'`); the attempt number, or null if not won. */
  startCharge(id: string, now: Date): Promise<number | null>;
  /** The call provably did not leave: forget the attempt (keeps the attempt counter). */
  clearChargeMark(id: string): Promise<void>;
  /** Moves the next lookup time of an `UNKNOWN` payment. */
  rescheduleResolve(
    id: string,
    patch: {
      nextResolveAt: Date;
      resolveChecks: number;
      lastStuckAlertAt?: Date;
    },
  ): Promise<void>;
  /** `UNKNOWN` payments due at `now`, oldest due first, claimed with `FOR UPDATE SKIP LOCKED` inside the open transaction. */
  claimDueUnknown(now: Date, limit: number): Promise<PaymentRecord[]>;
  /** The earliest `unknownSince` among `UNKNOWN` payments (for the age gauge), or null. */
  oldestUnknownSince(): Promise<Date | null>;
  /** Records the first refund request on a payment that is not refundable yet (no status change); keeps an earlier time. */
  markRefundRequested(id: string, now: Date, next: Date): Promise<void>;
  /** Moves the next refund attempt of a `REFUND_PENDING` payment. */
  rescheduleRefund(id: string, next: Date | null): Promise<void>;
  /** `REFUND_PENDING` payments due at `now`, claimed with `FOR UPDATE SKIP LOCKED` inside the open transaction. */
  claimDueRefunds(now: Date, limit: number): Promise<PaymentRecord[]>;
  /** The earliest `refundRequestedAt` among `REFUND_PENDING` payments (for the age gauge), or null. */
  oldestRefundPendingSince(): Promise<Date | null>;
}

export interface PaymentHistoryEntry {
  paymentId: string;
  version: number;
  fromStatus: PaymentStatus | null;
  toStatus: PaymentStatus;
  reason: string | null;
  actor: string;
  at: Date;
}

/** Append-only: there is no update and no delete. */
export interface PaymentHistoryRepository {
  insert(entry: PaymentHistoryEntry): Promise<void>;
  listByPayment(paymentId: string): Promise<PaymentHistoryEntry[]>;
}

export interface OrderCopyRepository {
  /** One statement, version guarded (`orderVersion < EXCLUDED.orderVersion`); false when the message was stale. */
  upsertVersioned(copy: OrderCopy, now: Date): Promise<boolean>;
  find(orderId: string): Promise<OrderCopy | null>;
}

export interface CreateIntentInput {
  paymentId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  paymentMethodToken: string;
  /** The provider's idempotency key and reference: the order id. */
  referenceKey: string;
}

/**
 * The payment provider behind the anti-corruption boundary. Every method answers with a `ProviderResponse` instead of
 * throwing for provider trouble; breakers, timeouts and `maxNetworkRetries: 0` live in the adapter.
 */
export interface PaymentProvider {
  createIntent(input: CreateIntentInput): Promise<ProviderResponse>;
  retrieveIntent(intentId: string): Promise<ProviderResponse>;
  findIntentByReference(orderId: string): Promise<ProviderResponse>;
  cancelIntent(intentId: string, key: string): Promise<ProviderResponse>;
  /** Full refund of the charge; `key` is `refund:<paymentId>`. */
  createRefund(intentId: string, key: string): Promise<ProviderResponse>;
  /** The refunds the provider holds for the charge. */
  findRefunds(intentId: string): Promise<ProviderResponse>;
}

export interface LedgerPosting {
  /** Inside the caller's transaction; idempotent per payment. */
  recordCaptured(payment: PaymentRecord): Promise<void>;
  recordRefunded(payment: PaymentRecord): Promise<void>;
}

export interface RealtimePort {
  /** After commit; failures are logged and counted, never thrown. */
  pushPaymentStatus(payment: PaymentRecord): Promise<void>;
}

export interface RefreshGate {
  /** `SET NX PX`: true for the one caller that may refresh now. */
  tryAcquire(paymentId: string, ttlMs: number): Promise<boolean>;
}

export const PAYMENT_REPOSITORY = Symbol('PAYMENT_REPOSITORY');
export const PAYMENT_HISTORY_REPOSITORY = Symbol('PAYMENT_HISTORY_REPOSITORY');
export const ORDER_COPY_REPOSITORY = Symbol('ORDER_COPY_REPOSITORY');
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
export const LEDGER_POSTING = Symbol('LEDGER_POSTING');
export const REALTIME_PORT = Symbol('REALTIME_PORT');
export const REFRESH_GATE = Symbol('REFRESH_GATE');
/** `() => number` in [0, 1): injected so backoff tests are deterministic. */
export const RANDOM = Symbol('RANDOM');
