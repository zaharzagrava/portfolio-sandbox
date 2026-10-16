import {
  DELIVERY_COMMAND_TYPES,
  DELIVERY_STATUS_VALUES,
  decide,
  transition,
  type DeliveryCommand,
  type DeliveryStatus,
} from './delivery-state';

const COURIER = 'c1';

const command = (type: DeliveryCommand['type']): DeliveryCommand => {
  switch (type) {
    case 'offer':
      return { type, actor: 'system', courierId: COURIER };
    case 'offerLapsed':
      return { type, actor: 'system' };
    case 'accept':
    case 'pickUp':
    case 'deliver':
      return { type, actor: 'courier', courierId: COURIER };
    case 'cancel':
      return { type, actor: 'shop', reason: 'buyer_changed_mind' };
  }
};

/** AS-28: exactly these moves, nothing else. */
const ALLOWED: Record<
  DeliveryCommand['type'],
  Partial<Record<DeliveryStatus, DeliveryStatus>>
> = {
  offer: { REQUESTED: 'OFFERED' },
  offerLapsed: { OFFERED: 'REQUESTED' },
  accept: { OFFERED: 'ASSIGNED' },
  pickUp: { ASSIGNED: 'PICKED_UP' },
  deliver: { PICKED_UP: 'DELIVERED' },
  cancel: {
    REQUESTED: 'CANCELLED',
    OFFERED: 'CANCELLED',
    ASSIGNED: 'CANCELLED',
  },
};

const pairs = DELIVERY_STATUS_VALUES.flatMap((status) =>
  DELIVERY_COMMAND_TYPES.map((type) => [status, type] as const),
);

describe('delivery state machine', () => {
  it('S20 AS-28: covers six statuses and six commands', () => {
    expect(DELIVERY_STATUS_VALUES).toHaveLength(6);
    expect(DELIVERY_COMMAND_TYPES).toHaveLength(6);
    expect(pairs).toHaveLength(36);
  });

  it.each(pairs)(
    'S20 AS-28: %s x %s follows the transition table',
    (status, type) => {
      const target = ALLOWED[type][status];
      const result = decide(status, command(type));
      if (target) expect(result).toEqual({ ok: true, to: target });
      else expect(result).toEqual({ ok: false });
    },
  );

  it.each(['DELIVERED', 'CANCELLED'] as const)(
    'S20 AS-28: terminal status %s allows no command',
    (status) => {
      for (const type of DELIVERY_COMMAND_TYPES)
        expect(decide(status, command(type)).ok).toBe(false);
    },
  );

  it.each(DELIVERY_COMMAND_TYPES)(
    'S20 AS-28: transition(%s) lists the allowed source statuses for the conditional update',
    (type) => {
      const { from, to } = transition(command(type));
      expect([...from].sort()).toEqual(Object.keys(ALLOWED[type]).sort());
      for (const source of from) expect(ALLOWED[type][source]).toBe(to);
    },
  );

  it('S20 AS-28: an unknown command throws at run time', () => {
    expect(() =>
      transition({ type: 'teleport', actor: 'system' } as never),
    ).toThrow(/unhandled/);
    expect(() =>
      decide('REQUESTED', { type: 'teleport', actor: 'system' } as never),
    ).toThrow(/unhandled/);
  });

  it('S20 AS-28: an unknown status throws at run time', () => {
    expect(() => decide('LOST' as never, command('cancel'))).toThrow(
      /unhandled/,
    );
  });
});
