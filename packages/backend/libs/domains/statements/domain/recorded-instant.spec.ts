import {
  microsToDate,
  microsToIso,
  nextRecordedMicros,
  toMicros,
} from './recorded-instant';

describe('S16 AS-07 strictly increasing record instants', () => {
  const t = toMicros(new Date('2026-04-01T09:00:00.000Z'));

  it.each([
    ['no earlier belief', null, t],
    ['an earlier instant', t - 5_000_000n, t],
    ['the same instant', t, t + 1n],
    ['an instant ahead of the clock', t + 10n, t + 11n],
  ])(
    'S16 AS-07: with %s the record instant is %p',
    (_name, last, expected) => {
      expect(nextRecordedMicros(new Date('2026-04-01T09:00:00.000Z'), last)).toBe(
        expected,
      );
    },
  );

  it('S16 AS-07: two changes at one frozen instant never give an empty recorded period', () => {
    const now = new Date('2026-04-01T09:00:00.000Z');
    const first = nextRecordedMicros(now, null);
    const second = nextRecordedMicros(now, first);
    const third = nextRecordedMicros(now, second);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('S16 AS-07: converts to a timestamp with microseconds and to a millisecond date', () => {
    const micros = toMicros(new Date('2026-04-01T09:00:00.123Z')) + 456n;
    expect(microsToIso(micros)).toBe('2026-04-01T09:00:00.123456Z');
    expect(microsToDate(micros).toISOString()).toBe('2026-04-01T09:00:00.123Z');
  });
});
