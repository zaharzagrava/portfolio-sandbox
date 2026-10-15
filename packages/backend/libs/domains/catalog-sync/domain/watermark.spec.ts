import fc from 'fast-check';
import { OVERLAP_MS, advanceWatermark, sinceFor } from './watermark';

const W = new Date('2026-10-15T12:00:00.000Z');
const now = new Date('2026-10-15T13:00:00.000Z');

describe('S08 watermark', () => {
  it('S08 AS-16: the overlap is exactly 5 minutes and the provider is asked since W - 5 min', () => {
    expect(OVERLAP_MS).toBe(300_000);
    expect(sinceFor(W)).toEqual(new Date('2026-10-15T11:55:00.000Z'));
  });

  it('S08 AS-16: advances to the largest fetched updatedAt (not now)', () => {
    const next = advanceWatermark({
      current: W,
      fetched: [
        new Date('2026-10-15T12:01:00Z'),
        new Date('2026-10-15T12:10:00Z'),
        new Date('2026-10-15T11:58:00Z'),
      ],
      now,
    });
    expect(next).toEqual(new Date('2026-10-15T12:10:00Z'));
  });

  it('S08 AS-16: nothing new keeps the watermark; first run without items stays null', () => {
    expect(advanceWatermark({ current: W, fetched: [], now })).toEqual(W);
    expect(
      advanceWatermark({
        current: W,
        fetched: [new Date('2026-10-15T11:58:00Z')],
        now,
      }),
    ).toEqual(W);
    expect(advanceWatermark({ current: null, fetched: [], now })).toBeNull();
    expect(
      advanceWatermark({
        current: null,
        fetched: [new Date('2026-10-15T11:00:00Z')],
        now,
      }),
    ).toEqual(new Date('2026-10-15T11:00:00Z'));
  });

  it('S08 AS-17: a future updatedAt is clamped to now', () => {
    expect(
      advanceWatermark({
        current: W,
        fetched: [new Date('2027-01-01T00:00:00Z')],
        now,
      }),
    ).toEqual(now);
  });

  it('S08 AS-17/AS-18: never moves backwards, even when now is before the stored watermark', () => {
    expect(
      advanceWatermark({
        current: W,
        fetched: [new Date('2026-10-15T12:30:00Z')],
        now: new Date('2026-10-15T11:00:00Z'),
      }),
    ).toEqual(W);
  });

  it('S08 AS-16/AS-17: property - never below current, never above max(current, now)', () => {
    const date = fc.date({
      min: new Date('2020-01-01'),
      max: new Date('2030-01-01'),
      noInvalidDate: true,
    });
    fc.assert(
      fc.property(
        fc.option(date, { nil: null }),
        fc.array(date, { maxLength: 6 }),
        date,
        (current, fetched, at) => {
          const next = advanceWatermark({ current, fetched, now: at });
          if (current && next)
            expect(next.getTime()).toBeGreaterThanOrEqual(current.getTime());
          if (next) {
            const ceiling = Math.max(current?.getTime() ?? 0, at.getTime());
            expect(next.getTime()).toBeLessThanOrEqual(ceiling);
          }
          if (current === null && fetched.length === 0) expect(next).toBeNull();
        },
      ),
    );
  });
});
