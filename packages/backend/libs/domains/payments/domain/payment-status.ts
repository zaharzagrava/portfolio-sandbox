import type { PaymentFailureCode } from '@marketplace-sandbox/contracts';

/**
 * The payment state machine (S13 data-model.md), pure: no clock, no I/O. Every status change goes through `decide`;
 * the transition service applies the answer with a conditional update.
 */
export const PAYMENT_STATUSES = [
  'PENDING',
  'UNKNOWN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'REFUND_PENDING',
  'REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type UnknownReason =
  'provider_timeout' | 'crash_recovery' | 'provider_response_invalid';

export type CancelReason = 'order_cancelled' | 'order_not_payable';

export type PaymentCommand =
  | { type: 'succeed' }
  | { type: 'fail'; code: PaymentFailureCode }
  | { type: 'markUnknown'; reason: UnknownReason }
  | { type: 'awaitCustomer' }
  | { type: 'cancel'; reason: CancelReason }
  | { type: 'requestRefund' }
  | { type: 'refundSucceeded' };

export interface DecisionContext {
  /** A charge attempt is recorded on the payment (`chargeAttemptedAt` is set). */
  attempted?: boolean;
  /** The provider is waiting for the customer (3-D Secure etc.): nothing was charged yet. */
  requiresAction?: boolean;
}

export interface Decision {
  to: PaymentStatus;
  /** 0 for the flag-only move (`awaitCustomer` on `PENDING`), 1 for every real status change. */
  versionStep: 0 | 1;
}

export class InvalidPaymentTransition extends Error {
  constructor(
    readonly from: PaymentStatus,
    readonly command: PaymentCommand['type'],
  ) {
    super(`payment cannot ${command} from ${from}`);
    this.name = 'InvalidPaymentTransition';
  }
}

export const isTerminal = (status: PaymentStatus): boolean =>
  status === 'FAILED' || status === 'CANCELLED' || status === 'REFUNDED';

export function assertNever(value: never): never {
  throw new Error(`unhandled value ${String(value)}`);
}

const move = (to: PaymentStatus, versionStep: 0 | 1 = 1): Decision => ({
  to,
  versionStep,
});

/** Where `command` takes a payment in `from`; throws `InvalidPaymentTransition` for every pair not in the table. */
export function decide(
  from: PaymentStatus,
  command: PaymentCommand,
  context: DecisionContext = {},
): Decision {
  const invalid = () => new InvalidPaymentTransition(from, command.type);
  switch (from) {
    case 'PENDING':
      switch (command.type) {
        case 'succeed':
          return move('COMPLETED');
        case 'fail':
          return move('FAILED');
        case 'markUnknown':
          return move('UNKNOWN');
        case 'awaitCustomer':
          return move('PENDING', 0);
        case 'cancel':
          if (context.attempted && !context.requiresAction) throw invalid();
          return move('CANCELLED');
        case 'requestRefund':
        case 'refundSucceeded':
          throw invalid();
        default:
          return assertNever(command);
      }
    case 'UNKNOWN':
      switch (command.type) {
        case 'succeed':
          return move('COMPLETED');
        case 'fail':
          return move('FAILED');
        case 'awaitCustomer':
          return move('PENDING');
        case 'markUnknown':
        case 'cancel':
        case 'requestRefund':
        case 'refundSucceeded':
          throw invalid();
        default:
          return assertNever(command);
      }
    case 'COMPLETED':
      if (command.type === 'requestRefund') return move('REFUND_PENDING');
      throw invalid();
    case 'REFUND_PENDING':
      if (command.type === 'refundSucceeded') return move('REFUNDED');
      throw invalid();
    case 'FAILED':
    case 'CANCELLED':
    case 'REFUNDED':
      throw invalid();
    default:
      return assertNever(from);
  }
}
