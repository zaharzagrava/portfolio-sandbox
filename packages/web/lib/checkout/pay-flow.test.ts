import { describe, expect, it } from 'vitest';
import type { PaymentStatusValue } from '@marketplace-sandbox/contracts';
import {
  PAY_EVENTS,
  PAY_PHASES,
  eventForServer,
  initialPayState,
  payReducer,
  serverView,
  type PayEvent,
  type PayPhase,
  type PayState,
} from './pay-flow';

/**
 * The table of allowed (phase, event) pairs of data-model.md "Pay phases" is written out here independently of the
 * reducer. Every other pair of the full cross product must return the same state.
 */
const ALLOWED: Record<PayPhase, Partial<Record<PayEvent, PayPhase>>> = {
  idle: { PRESS_PAY: 'tokenizing', RESERVATION_ENDED: 'expired' },
  tokenizing: { TOKEN_READY: 'submitting', TOKEN_FAILED: 'idle' },
  submitting: { ACCEPTED: 'processing', SUBMIT_REJECTED: 'idle', ORDER_PAID: 'completed' },
  processing: { ACTION_REQUIRED: 'actionRequired', PAYMENT_UNKNOWN: 'unknown', PAYMENT_COMPLETED: 'confirming', ORDER_PAID: 'completed', PAYMENT_FAILED: 'failed' },
  actionRequired: {
    ACTION_DONE: 'processing',
    RESERVATION_ENDED: 'expired',
    PAYMENT_UNKNOWN: 'unknown',
    PAYMENT_COMPLETED: 'confirming',
    ORDER_PAID: 'completed',
    PAYMENT_FAILED: 'failed',
  },
  confirming: { PAYMENT_UNKNOWN: 'unknown', ORDER_PAID: 'completed' },
  unknown: { PAYMENT_COMPLETED: 'confirming', ORDER_PAID: 'completed', PAYMENT_FAILED: 'failed' },
  failed: {},
  completed: {},
  expired: {},
};

describe('pay phases', () => {
  it('W03 AS-71: the phase set is closed and exactly the ten of FR-051', () => {
    expect([...PAY_PHASES].sort()).toEqual(
      ['actionRequired', 'completed', 'confirming', 'expired', 'failed', 'idle', 'processing', 'submitting', 'tokenizing', 'unknown'].sort(),
    );
  });

  it('W03 AS-71: failed, completed and expired are terminal (no event moves them)', () => {
    for (const phase of ['failed', 'completed', 'expired'] as const) expect(ALLOWED[phase]).toEqual({});
  });
});

describe.each(PAY_PHASES.map((phase) => [phase] as const))('W03 AS-71 payReducer from %s', (phase) => {
  it.each(PAY_EVENTS.map((event) => [event] as const))('on %s', (event) => {
    const state: PayState = { phase };
    const next = payReducer(state, { type: event });
    const target = ALLOWED[phase][event];
    if (target) expect(next).toEqual({ phase: target });
    else expect(next).toBe(state);
  });
});

describe('impossible pairs cannot be represented', () => {
  it('W03 AS-38: submitting never goes straight to failed and idle never goes to completed', () => {
    expect(payReducer({ phase: 'submitting' }, { type: 'PAYMENT_FAILED' })).toEqual({ phase: 'submitting' });
    expect(payReducer({ phase: 'idle' }, { type: 'ORDER_PAID' })).toEqual({ phase: 'idle' });
  });

  it('W03 AS-42: an unknown event type returns the same state', () => {
    const state: PayState = { phase: 'processing' };
    expect(payReducer(state, { type: 'NOPE' } as never)).toBe(state);
  });
});

describe('serverView mapping (data-model "Mapping from server data")', () => {
  const payment = (status: PaymentStatusValue, requiresAction = false) => ({ status, requiresAction });

  it.each([
    ['PENDING + requiresAction', payment('PENDING', true), 'RESERVED', { kind: 'phase', phase: 'actionRequired' }],
    ['PENDING', payment('PENDING'), 'RESERVED', { kind: 'phase', phase: 'processing' }],
    ['UNKNOWN', payment('UNKNOWN'), 'RESERVED', { kind: 'phase', phase: 'unknown' }],
    ['COMPLETED, order RESERVED', payment('COMPLETED'), 'RESERVED', { kind: 'phase', phase: 'confirming' }],
    ['COMPLETED, order PENDING', payment('COMPLETED'), 'PENDING', { kind: 'phase', phase: 'confirming' }],
    ['COMPLETED, order PAID', payment('COMPLETED'), 'PAID', { kind: 'phase', phase: 'completed' }],
    ['COMPLETED, order DELIVERED', payment('COMPLETED'), 'DELIVERED', { kind: 'phase', phase: 'completed' }],
    ['FAILED', payment('FAILED'), 'RESERVED', { kind: 'phase', phase: 'failed' }],
    ['no payment, RESERVED', null, 'RESERVED', { kind: 'phase', phase: 'idle' }],
    ['no payment, PENDING', null, 'PENDING', { kind: 'phase', phase: 'idle' }],
  ] as const)('W03 AS-38/AS-42/AS-46: %s', (_name, pay, order, expected) => {
    expect(serverView({ payment: pay, orderStatus: order })).toEqual(expected);
  });

  it('W03 AS-46: payment COMPLETED with the order not PAID is never completed', () => {
    for (const orderStatus of ['PENDING', 'RESERVED'] as const) {
      expect(serverView({ payment: payment('COMPLETED'), orderStatus })).not.toEqual({ kind: 'phase', phase: 'completed' });
    }
  });

  it.each([
    ['CANCELLED', null, 'cancelled', false],
    ['CANCELLED', payment('FAILED'), 'cancelled', false],
    ['CANCELLED', payment('COMPLETED'), 'cancelled', true],
    ['CANCELLED', payment('REFUND_PENDING'), 'cancelled', true],
    ['CANCELLED', payment('REFUNDED'), 'cancelled', true],
    ['CANCELLED', payment('CANCELLED'), 'cancelled', false],
    ['REFUNDED', payment('REFUNDED'), 'refunded', true],
  ] as const)('W03 AS-43: order %s with payment %j shows the %s panel (late-payment notice: %s)', (orderStatus, pay, reason, late) => {
    expect(serverView({ payment: pay, orderStatus })).toEqual({ kind: 'order-ended', reason, paymentArrivedLate: late });
  });

  it('W03 AS-43: the cancelled panel is chosen over any payment phase', () => {
    expect(serverView({ payment: payment('PENDING', true), orderStatus: 'CANCELLED' }).kind).toBe('order-ended');
  });
});

describe('initialPayState and eventForServer', () => {
  it('W03 AS-39: a reload during processing starts in processing, not idle', () => {
    expect(initialPayState({ payment: { status: 'PENDING', requiresAction: false }, orderStatus: 'RESERVED' })).toEqual({ phase: 'processing' });
    expect(initialPayState({ payment: null, orderStatus: 'RESERVED' })).toEqual({ phase: 'idle' });
    expect(initialPayState({ payment: { status: 'COMPLETED', requiresAction: false }, orderStatus: 'RESERVED' })).toEqual({ phase: 'confirming' });
  });

  it('W03 AS-43: an ended order starts in idle (the panel is the view, not a phase)', () => {
    expect(initialPayState({ payment: null, orderStatus: 'CANCELLED' })).toEqual({ phase: 'idle' });
  });

  it.each([
    ['submitting', 'PENDING', false, 'RESERVED', 'ACCEPTED'],
    ['processing', 'PENDING', true, 'RESERVED', 'ACTION_REQUIRED'],
    ['actionRequired', 'PENDING', false, 'RESERVED', 'ACTION_DONE'],
    ['processing', 'UNKNOWN', false, 'RESERVED', 'PAYMENT_UNKNOWN'],
    ['confirming', 'UNKNOWN', false, 'RESERVED', 'PAYMENT_UNKNOWN'],
    ['processing', 'COMPLETED', false, 'RESERVED', 'PAYMENT_COMPLETED'],
    ['unknown', 'COMPLETED', false, 'RESERVED', 'PAYMENT_COMPLETED'],
    ['processing', 'COMPLETED', false, 'PAID', 'ORDER_PAID'],
    ['confirming', 'COMPLETED', false, 'PAID', 'ORDER_PAID'],
    ['processing', 'FAILED', false, 'RESERVED', 'PAYMENT_FAILED'],
    ['unknown', 'FAILED', false, 'RESERVED', 'PAYMENT_FAILED'],
  ] as const)('W03 AS-38/AS-46: from %s, payment %s (action %s) with order %s sends %s', (phase, status, requiresAction, orderStatus, expected) => {
    const event = eventForServer(phase, { payment: { status, requiresAction }, orderStatus });
    expect(event).toBe(expected);
    expect(payReducer({ phase }, { type: event as PayEvent }).phase).not.toBe(phase);
  });

  it.each([
    ['processing', 'PENDING', false, 'RESERVED'],
    ['actionRequired', 'PENDING', true, 'RESERVED'],
    ['confirming', 'COMPLETED', false, 'RESERVED'],
    ['completed', 'COMPLETED', false, 'PAID'],
  ] as const)('W03 AS-39: from %s, an unchanged server state (%s) sends nothing', (phase, status, requiresAction, orderStatus) => {
    expect(eventForServer(phase, { payment: { status, requiresAction }, orderStatus })).toBeNull();
  });

  it('W03 AS-43: an ended order or no payment sends nothing', () => {
    expect(eventForServer('processing', { payment: null, orderStatus: 'RESERVED' })).toBeNull();
    expect(eventForServer('processing', { payment: { status: 'PENDING', requiresAction: false }, orderStatus: 'CANCELLED' })).toBeNull();
  });
});
