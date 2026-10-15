import {
  compareHlc,
  decodeHlc,
  encodeHlc,
  expired,
  plausible,
  receive,
  tick,
} from './hlc';

const hlc = (physical: number, logical = 0, node = 'dev-a') => ({
  physical,
  logical,
  node,
});

describe('hybrid logical clock', () => {
  it.each([
    ['not a clock', null],
    ['', null],
    ['1-2-dev-a', null],
    ['000000000001000-00000-', null],
    ['000000000001000-0000-dev-a', null],
    ['00000000000100x-00000-dev-a', null],
    ['000000000001000-00000-dev a', null],
    ['000000000001000-00000-dev-a', hlc(1000, 0, 'dev-a')],
    ['000000000001000-00007-dev_B-1', hlc(1000, 7, 'dev_B-1')],
  ])('S09 AS-20: decode %j', (value, expected) => {
    expect(decodeHlc(value)).toEqual(expected);
  });

  it('S09 AS-23: encoded clocks sort like their time, and a clock goes through encode and decode unchanged', () => {
    const a = hlc(1_000, 0, 'dev-a');
    const b = hlc(1_000, 1, 'dev-a');
    expect(encodeHlc(a) < encodeHlc(b)).toBe(true);
    expect(decodeHlc(encodeHlc(b))).toEqual(b);
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(compareHlc(b, a)).toBeGreaterThan(0);
    expect(compareHlc(a, { ...a })).toBe(0);
    expect(compareHlc(hlc(5, 0, 'dev-a'), hlc(5, 0, 'dev-b'))).toBeLessThan(0);
  });

  it('S09 AS-23: tick never goes backwards, receive is after both clocks', () => {
    const local = hlc(1_000, 0, 'server-1');
    const ticked = tick(local, 900);
    expect(compareHlc(ticked, local)).toBeGreaterThan(0);
    const remote = hlc(5_000, 3, 'dev-b');
    const merged = receive(ticked, remote, 1_200);
    expect(compareHlc(merged, remote)).toBeGreaterThan(0);
    expect(compareHlc(merged, ticked)).toBeGreaterThan(0);
    expect(merged.node).toBe('server-1');
  });

  it.each([
    ['exactly 60 s ahead', 1_000_000 + 60_000, true],
    ['60.001 s ahead', 1_000_000 + 60_001, false],
    ['in the past', 1_000_000 - 10 * 86_400_000, true],
    ['now', 1_000_000, true],
  ])('S09 AS-19: plausible, %s', (_name, physical, ok) => {
    expect(plausible(hlc(physical), 1_000_000, 60_000)).toBe(ok);
  });

  it('S09 AS-19: the drift is a parameter', () => {
    expect(plausible(hlc(1_000_000 + 5_000), 1_000_000, 4_000)).toBe(false);
    expect(plausible(hlc(1_000_000 + 5_000), 1_000_000, 5_000)).toBe(true);
  });

  it.each([
    ['exactly 30 days behind', 30 * 86_400_000, false],
    ['30 days and 1 s behind', 30 * 86_400_000 + 1_000, true],
    ['1 day behind', 86_400_000, false],
  ])('S09 AS-21: expired, %s', (_name, behind, isExpired) => {
    const now = 100 * 86_400_000;
    expect(expired(hlc(now - behind), now, 30 * 86_400_000)).toBe(isExpired);
  });
});
