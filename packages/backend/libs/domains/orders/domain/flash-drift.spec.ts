import * as fc from 'fast-check';
import { clampPlan, classify } from './flash-drift';

describe('S11 AS-46: flash drift classification', () => {
  describe('during the sale', () => {
    it.each([
      ['consistent', { units: 100, remainingFast: 60, reserved: 40 }, { kind: 'none' }],
      ['units in flight are not drift', { units: 100, remainingFast: 55, reserved: 40 }, { kind: 'none' }],
      [
        'restored snapshot: 90 remaining but only 60 possible',
        { units: 100, remainingFast: 90, reserved: 40 },
        { kind: 'phantom_stock', clampTo: 60, excess: 30 },
      ],
      [
        'phantom stock down to zero',
        { units: 100, remainingFast: 10, reserved: 100 },
        { kind: 'phantom_stock', clampTo: 0, excess: 10 },
      ],
      [
        'oversold: more durable than units',
        { units: 100, remainingFast: 0, reserved: 104 },
        { kind: 'oversold', excess: 4 },
      ],
      [
        'oversold wins over phantom stock',
        { units: 100, remainingFast: 20, reserved: 104 },
        { kind: 'oversold', excess: 4 },
      ],
    ])('S11 AS-46: %s', (_name, input, expected) => {
      expect(classify({ ...input, phase: 'during' })).toEqual(expected);
    });
  });

  describe('after the sale', () => {
    it.each([
      ['equal', { units: 3000, remainingFast: 600, reserved: 2400 }, { kind: 'none' }],
      ['590 vs 600 unsold', { units: 3000, remainingFast: 590, reserved: 2400 }, { kind: 'redis_low', driftUnits: 10 }],
      ['640 vs 600 unsold', { units: 3000, remainingFast: 640, reserved: 2400 }, { kind: 'redis_high', driftUnits: 40 }],
      ['everything sold', { units: 10, remainingFast: 0, reserved: 10 }, { kind: 'none' }],
      ['sold more than units, nothing unsold', { units: 10, remainingFast: 0, reserved: 12 }, { kind: 'none' }],
    ])('S11 AS-46: %s', (_name, input, expected) => {
      expect(classify({ ...input, phase: 'after' })).toEqual(expected);
    });
  });

  describe('clampPlan', () => {
    it.each([
      [[10, 10, 10], 30, [10, 10, 10]],
      [[10, 10, 10], 31, [10, 10, 10]],
      [[10, 10, 10], 27, [9, 9, 9]],
      [[10, 10, 10], 28, [9, 9, 10]],
      [[20, 5, 1], 10, [4, 5, 1]],
      [[20, 5, 1], 0, [0, 0, 0]],
      [[-2, 5, 3], 4, [-2, 2, 2]],
      [[0, 0], 3, [0, 0]],
    ])('S11 AS-46: %j to %i -> %j', (contents, target, expected) => {
      expect(clampPlan(contents, target)).toEqual(expected);
    });

    it('S11 AS-46: clamp lowers, never raises, and lands on the target', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: -5, max: 500 }), { minLength: 1, maxLength: 64 }),
          fc.integer({ min: 0, max: 5_000 }),
          (contents, target) => {
            const out = clampPlan(contents, target);
            expect(out).toHaveLength(contents.length);
            out.forEach((v, i) => expect(v).toBeLessThanOrEqual(contents[i]));
            out.forEach((v, i) => {
              if (contents[i] >= 0) expect(v).toBeGreaterThanOrEqual(0);
              else expect(v).toBe(contents[i]);
            });
            const before = contents.reduce((s, c) => s + Math.max(0, c), 0);
            const after = out.reduce((s, c) => s + Math.max(0, c), 0);
            expect(after).toBe(Math.min(before, target));
          },
        ),
      );
    });
  });
});
