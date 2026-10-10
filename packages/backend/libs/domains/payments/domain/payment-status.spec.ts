import {
  decide,
  InvalidPaymentTransition,
  isTerminal,
  PAYMENT_STATUSES,
  type PaymentCommand,
  type PaymentStatus,
} from './payment-status';

const commands: PaymentCommand[] = [
  { type: 'succeed' },
  { type: 'fail', code: 'card_declined' },
  { type: 'markUnknown', reason: 'provider_timeout' },
  { type: 'awaitCustomer' },
  { type: 'cancel', reason: 'order_cancelled' },
  { type: 'requestRefund' },
  { type: 'refundSucceeded' },
];

/** status → command type → resulting status (version step), the allowed list of data-model.md. */
const allowed: Record<string, [PaymentStatus, 0 | 1]> = {
  'PENDING/succeed': ['COMPLETED', 1],
  'PENDING/fail': ['FAILED', 1],
  'PENDING/markUnknown': ['UNKNOWN', 1],
  'PENDING/awaitCustomer': ['PENDING', 0],
  'PENDING/cancel': ['CANCELLED', 1],
  'UNKNOWN/succeed': ['COMPLETED', 1],
  'UNKNOWN/fail': ['FAILED', 1],
  'UNKNOWN/awaitCustomer': ['PENDING', 1],
  'COMPLETED/requestRefund': ['REFUND_PENDING', 1],
  'REFUND_PENDING/refundSucceeded': ['REFUNDED', 1],
};

const cases = PAYMENT_STATUSES.flatMap((from) =>
  commands.map((command) => ({ from, command })),
);

describe('S13 AS-39: payment transition table', () => {
  it('covers 7 statuses and 7 commands', () => {
    expect(PAYMENT_STATUSES).toHaveLength(7);
    expect(cases).toHaveLength(49);
  });

  it.each(cases)(
    '$from + $command.type follows the allowed list',
    ({ from, command }) => {
      const expected = allowed[`${from}/${command.type}`];
      const ctx = { attempted: false, requiresAction: false };
      if (!expected) {
        expect(() => decide(from, command, ctx)).toThrow(
          InvalidPaymentTransition,
        );
        return;
      }
      expect(decide(from, command, ctx)).toEqual({
        to: expected[0],
        versionStep: expected[1],
      });
    },
  );

  it('InvalidPaymentTransition carries the status and the command', () => {
    try {
      decide('FAILED', { type: 'succeed' }, { attempted: true });
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPaymentTransition);
      expect(error).toMatchObject({ from: 'FAILED', command: 'succeed' });
    }
  });

  it('awaitCustomer on PENDING keeps the version', () => {
    expect(decide('PENDING', { type: 'awaitCustomer' }, {}).versionStep).toBe(
      0,
    );
  });

  it('cancel is refused once a charge attempt is recorded, unless the customer is the one we wait for', () => {
    const cancel: PaymentCommand = {
      type: 'cancel',
      reason: 'order_cancelled',
    };
    expect(decide('PENDING', cancel, { attempted: false }).to).toBe(
      'CANCELLED',
    );
    expect(() => decide('PENDING', cancel, { attempted: true })).toThrow(
      InvalidPaymentTransition,
    );
    expect(
      decide('PENDING', cancel, { attempted: true, requiresAction: true }).to,
    ).toBe('CANCELLED');
  });

  it('FAILED, CANCELLED and REFUNDED are terminal; COMPLETED only leaves through a refund request', () => {
    for (const s of ['FAILED', 'CANCELLED', 'REFUNDED'] as const)
      expect(isTerminal(s)).toBe(true);
    for (const s of [
      'PENDING',
      'UNKNOWN',
      'COMPLETED',
      'REFUND_PENDING',
    ] as const)
      expect(isTerminal(s)).toBe(false);
    for (const command of commands.filter((c) => c.type !== 'requestRefund'))
      expect(() => decide('COMPLETED', command, {})).toThrow(
        InvalidPaymentTransition,
      );
  });
});
