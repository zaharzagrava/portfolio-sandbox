import { describe, expect, it } from 'vitest';
import { FALLBACK_SILENCE_MS, POLL_OFFSETS_MS, nextPollDelay } from './polling';

describe('polling schedule', () => {
  it('W03 AS-39: the stream counts as down after 10 seconds of silence', () => {
    expect(FALLBACK_SILENCE_MS).toBe(10_000);
  });

  it('W03 AS-39: every 2 seconds for the first 30 seconds, then every 5 seconds for 5 minutes', () => {
    const fast = POLL_OFFSETS_MS.filter((at) => at <= 30_000);
    const slow = POLL_OFFSETS_MS.filter((at) => at > 30_000);
    expect(fast).toEqual([2000, 4000, 6000, 8000, 10_000, 12_000, 14_000, 16_000, 18_000, 20_000, 22_000, 24_000, 26_000, 28_000, 30_000]);
    expect(slow[0]).toBe(35_000);
    expect(slow.at(-1)).toBe(330_000);
    expect(slow).toHaveLength(60);
    expect(new Set(slow.slice(1).map((at, i) => at - slow[i])).size).toBe(1);
  });

  it('W03 AS-39: no 60-second window holds more than 30 requests', () => {
    const worst = POLL_OFFSETS_MS.map((start) => POLL_OFFSETS_MS.filter((at) => at >= start && at < start + 60_000).length);
    expect(Math.max(...worst)).toBeLessThanOrEqual(30);
  });

  it.each([
    [0, 2000],
    [1999, 1],
    [2000, 2000],
    [29_000, 1000],
    [30_000, 5000],
    [31_000, 4000],
    [329_999, 1],
    [330_000, null],
    [900_000, null],
  ])('W03 AS-39: %i ms after the start the next poll is in %s ms', (elapsed, expected) => {
    expect(nextPollDelay(elapsed)).toBe(expected);
  });
});
