import {
  ORDER_STATUSES,
  TERMINAL_STATUSES,
  decide,
  type OrderCommand,
  type OrderStatus,
} from './order-state';

const CANCEL_REASONS = [
  'out_of_stock',
  'payment_failed',
  'hold_expired',
  'user_cancelled',
] as const;

const commands: Array<[string, OrderCommand]> = [
  ['reserve', { type: 'reserve' }],
  ['markPaid', { type: 'markPaid', paymentRef: 'pi_1' }],
  ...CANCEL_REASONS.map((reason): [string, OrderCommand] => [
    `cancel(${reason})`,
    { type: 'cancel', reason },
  ]),
  ['startFulfilment', { type: 'startFulfilment' }],
  ['ship', { type: 'ship', trackingCode: 'T1' }],
  ['deliver', { type: 'deliver' }],
  ['refund', { type: 'refund', reason: 'requested' }],
];

/** The allowed moves of data-model.md, written out independently of the implementation. */
const APPLY: Record<string, Partial<Record<OrderStatus, OrderStatus>>> = {
  reserve: { PENDING: 'RESERVED' },
  markPaid: { RESERVED: 'PAID' },
  'cancel(out_of_stock)': { PENDING: 'CANCELLED' },
  'cancel(payment_failed)': { RESERVED: 'CANCELLED' },
  'cancel(hold_expired)': { RESERVED: 'CANCELLED' },
  'cancel(user_cancelled)': { RESERVED: 'CANCELLED' },
  startFulfilment: { PAID: 'FULFILLING' },
  ship: { FULFILLING: 'SHIPPED' },
  deliver: { SHIPPED: 'DELIVERED' },
  refund: { PAID: 'REFUNDED', FULFILLING: 'REFUNDED' },
};
/** Repeating a move that already happened is a no-op, not an error. */
const ALREADY: Record<string, OrderStatus[]> = {
  markPaid: ['PAID', 'FULFILLING', 'SHIPPED', 'DELIVERED', 'REFUNDED'],
  'cancel(out_of_stock)': ['CANCELLED'],
  'cancel(payment_failed)': ['CANCELLED'],
  'cancel(hold_expired)': ['CANCELLED'],
  'cancel(user_cancelled)': ['CANCELLED'],
  refund: ['REFUNDED'],
};

describe('S10 AS-54: order transition table', () => {
  const rows = commands.flatMap(([name, command]) =>
    ORDER_STATUSES.map((status) => [name, status, command] as const),
  );

  it.each(rows)('S10 AS-54: %s from %s', (name, status, command) => {
    const to = APPLY[name]?.[status];
    const already = ALREADY[name]?.includes(status) ?? false;
    const decision = decide(status, command);
    if (to) expect(decision).toEqual({ kind: 'apply', to });
    else if (already) expect(decision).toEqual({ kind: 'already_applied' });
    else expect(decision).toEqual({ kind: 'invalid' });
  });

  it('S10 AS-54: terminal states accept no applying move', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual([
      'CANCELLED',
      'DELIVERED',
      'REFUNDED',
    ]);
    for (const status of TERMINAL_STATUSES)
      for (const [, command] of commands)
        expect(decide(status, command).kind).not.toBe('apply');
  });

  it('S10 AS-54: the ordering PENDING → RESERVED → PAID → FULFILLING → SHIPPED → DELIVERED is the only forward path', () => {
    let status: OrderStatus = 'PENDING';
    const path: OrderCommand[] = [
      { type: 'reserve' },
      { type: 'markPaid', paymentRef: 'p' },
      { type: 'startFulfilment' },
      { type: 'ship', trackingCode: 't' },
      { type: 'deliver' },
    ];
    for (const command of path) {
      const d = decide(status, command);
      expect(d.kind).toBe('apply');
      if (d.kind === 'apply') status = d.to;
    }
    expect(status).toBe('DELIVERED');
  });

  it('S10 AS-54: an unknown command type is a compile error (exhaustive switch)', () => {
    // @ts-expect-error — `refundPartial` is not an OrderCommand
    const bad: OrderCommand = { type: 'refundPartial' };
    // at run time an unknown command never applies
    expect(() => decide('PAID', bad)).toThrow();
  });
});
