import {
  isOpen,
  publicState,
  transition,
  type FlashCommand,
  type FlashSaleStatus,
} from './flash-sale-state';

const startsAt = new Date('2026-10-14T12:00:00.000Z');
const endsAt = new Date('2026-10-14T13:00:00.000Z');
const sale = { startsAt, endsAt };
const before = new Date(startsAt.getTime() - 1);

type Row = [FlashSaleStatus, FlashCommand, Date, string];
const load: FlashCommand = { type: 'load' };
const fail: FlashCommand = { type: 'fail', reason: 'insufficient_stock' };
const cancel: FlashCommand = { type: 'cancel' };
const end: FlashCommand = { type: 'end' };
const reconcile: FlashCommand = { type: 'reconcile' };

describe('S11 AS-45: flash sale state machine', () => {
  describe('transition', () => {
    it.each<Row>([
      ['SCHEDULED', load, before, 'applied:LOADED'],
      ['LOADED', load, before, 'already'],
      ['ENDED', load, endsAt, 'illegal'],
      ['CANCELLED', load, before, 'illegal'],
      ['START_FAILED', load, before, 'illegal'],
      ['RECONCILED', load, endsAt, 'illegal'],

      ['SCHEDULED', fail, before, 'applied:START_FAILED:insufficient_stock'],
      ['START_FAILED', fail, before, 'already'],
      ['LOADED', fail, before, 'illegal'],
      ['ENDED', fail, before, 'illegal'],
      ['CANCELLED', fail, before, 'illegal'],

      ['SCHEDULED', cancel, before, 'applied:CANCELLED:cancelled_by_shop'],
      ['LOADED', cancel, before, 'applied:CANCELLED:cancelled_by_shop'],
      ['LOADED', cancel, startsAt, 'illegal'],
      ['LOADED', cancel, new Date(startsAt.getTime() + 1), 'illegal'],
      ['CANCELLED', cancel, before, 'already'],
      ['ENDED', cancel, endsAt, 'illegal'],
      ['RECONCILED', cancel, endsAt, 'illegal'],
      ['START_FAILED', cancel, before, 'illegal'],

      ['LOADED', end, endsAt, 'applied:ENDED'],
      ['SCHEDULED', end, endsAt, 'applied:START_FAILED:window_missed'],
      ['ENDED', end, endsAt, 'already'],
      ['RECONCILED', end, endsAt, 'already'],
      ['CANCELLED', end, endsAt, 'illegal'],
      ['START_FAILED', end, endsAt, 'illegal'],

      ['ENDED', reconcile, endsAt, 'applied:RECONCILED'],
      ['RECONCILED', reconcile, endsAt, 'already'],
      ['LOADED', reconcile, endsAt, 'illegal'],
      ['SCHEDULED', reconcile, endsAt, 'illegal'],
      ['CANCELLED', reconcile, endsAt, 'illegal'],
      ['START_FAILED', reconcile, endsAt, 'illegal'],
    ])('S11 AS-45: %s + %j at %s is %s', (status, command, now, expected) => {
      const result = transition(status, command, now, sale);
      const label =
        result.kind === 'applied'
          ? ['applied', result.to, result.reason].filter(Boolean).join(':')
          : result.kind;
      expect(label).toBe(expected);
    });
  });

  describe('isOpen: window is [startsAt, endsAt)', () => {
    it.each([
      ['startsAt - 1 ms', new Date(startsAt.getTime() - 1), 'LOADED', false],
      ['startsAt', startsAt, 'LOADED', true],
      ['endsAt - 1 ms', new Date(endsAt.getTime() - 1), 'LOADED', true],
      ['endsAt', endsAt, 'LOADED', false],
      ['inside but SCHEDULED', startsAt, 'SCHEDULED', false],
      ['inside but ENDED', startsAt, 'ENDED', false],
      ['inside but CANCELLED', startsAt, 'CANCELLED', false],
    ] as const)('S11 AS-45: %s (%s) is %s', (_name, now, status, expected) => {
      expect(isOpen({ ...sale, status }, now)).toBe(expected);
    });
  });

  describe('publicState', () => {
    const hour = 3_600_000;
    it.each([
      ['LOADED', before, 5, 'UPCOMING'],
      ['SCHEDULED', before, null, 'UPCOMING'],
      ['LOADED', startsAt, 5, 'LIVE'],
      ['LOADED', startsAt, 0, 'SOLD_OUT'],
      ['LOADED', new Date(endsAt.getTime() - 1), 1, 'LIVE'],
      ['LOADED', endsAt, 0, 'ENDED'],
      ['ENDED', startsAt, 3, 'ENDED'],
      ['RECONCILED', startsAt, 0, 'ENDED'],
      ['CANCELLED', before, null, null],
      ['START_FAILED', before, null, null],
    ] as const)('S11 AS-45: %s at %s remaining %s is %s', (status, now, remaining, expected) => {
      expect(publicState({ ...sale, status }, now, remaining)).toBe(expected);
    });

    it('S11 AS-45: a sale that starts more than 24 h away is hidden', () => {
      const far = { startsAt: new Date(Date.now() + 30 * hour), endsAt: new Date(Date.now() + 31 * hour) };
      expect(publicState({ ...far, status: 'SCHEDULED' }, new Date(), null)).toBeNull();
      expect(
        publicState(
          { ...far, status: 'SCHEDULED' },
          new Date(far.startsAt.getTime() - 24 * hour),
          null,
        ),
      ).toBe('UPCOMING');
    });

    it('S11 AS-45: LIVE with an unknown remaining count stays LIVE', () => {
      expect(publicState({ ...sale, status: 'LOADED' }, startsAt, null)).toBe('LIVE');
    });
  });
});
