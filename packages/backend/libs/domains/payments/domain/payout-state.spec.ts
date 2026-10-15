import {
  PAYOUT_EVENTS,
  PAYOUT_STATUSES,
  isFinal,
  toPublicStatus,
  transition,
  type PayoutEvent,
  type PayoutStatus,
} from './payout-state';

const ALLOWED: Array<[PayoutStatus, PayoutEvent, PayoutStatus]> = [
  ['PENDING', 'claim', 'SENDING'],
  ['PENDING', 'cancel', 'CANCELLED'],
  ['SENDING', 'provider_success', 'PAID'],
  ['SENDING', 'provider_rejected', 'FAILED'],
  ['SENDING', 'provider_unknown', 'UNKNOWN'],
  ['SENDING', 'retries_exhausted', 'UNKNOWN'],
  ['SENDING', 'resolver_found_paid', 'PAID'],
  ['SENDING', 'resolver_found_rejected', 'FAILED'],
  ['UNKNOWN', 'resolver_found_paid', 'PAID'],
  ['UNKNOWN', 'resolver_found_rejected', 'FAILED'],
  ['UNKNOWN', 'provider_success', 'PAID'],
  ['UNKNOWN', 'provider_rejected', 'FAILED'],
];

describe('payout state machine (S15 AS-27)', () => {
  it('S15 AS-27: exactly twelve (state, event) pairs are allowed', () => {
    expect(ALLOWED).toHaveLength(12);
  });

  const table = PAYOUT_STATUSES.flatMap((status) =>
    PAYOUT_EVENTS.map((event) => {
      const allowed = ALLOWED.find(([s, e]) => s === status && e === event);
      return [status, event, allowed ? allowed[2] : null] as const;
    }),
  );

  it.each(table)('S15 AS-27: %s + %s -> %s', (status, event, expected) => {
    expect(transition(status, event)).toBe(expected);
  });

  it('S15 AS-27: PAID, FAILED and CANCELLED accept nothing', () => {
    for (const status of ['PAID', 'FAILED', 'CANCELLED'] as const) {
      expect(isFinal(status)).toBe(true);
      for (const event of PAYOUT_EVENTS)
        expect(transition(status, event)).toBeNull();
    }
    for (const status of ['PENDING', 'SENDING', 'UNKNOWN'] as const)
      expect(isFinal(status)).toBe(false);
  });

  it('S15 AS-27: every status and event is covered by the table', () => {
    expect(table).toHaveLength(PAYOUT_STATUSES.length * PAYOUT_EVENTS.length);
    expect(PAYOUT_STATUSES).toHaveLength(6);
    expect(PAYOUT_EVENTS).toHaveLength(8);
  });

  it('S15 AS-27: an unknown status or event is refused, never guessed', () => {
    expect(transition('BOGUS' as PayoutStatus, 'claim')).toBeNull();
    expect(transition('PENDING', 'bogus' as PayoutEvent)).toBeNull();
  });

  it('S15 AS-31: SENDING and UNKNOWN are shown to sellers as IN_TRANSIT', () => {
    expect(toPublicStatus('PENDING')).toBe('PENDING');
    expect(toPublicStatus('SENDING')).toBe('IN_TRANSIT');
    expect(toPublicStatus('UNKNOWN')).toBe('IN_TRANSIT');
    expect(toPublicStatus('PAID')).toBe('PAID');
    expect(toPublicStatus('FAILED')).toBe('FAILED');
    expect(toPublicStatus('CANCELLED')).toBe('CANCELLED');
  });
});
