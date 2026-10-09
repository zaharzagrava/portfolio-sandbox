import fc from 'fast-check';
import { applyIfNewer } from './sinks/apply-if-newer';

describe('S53 version guard decision', () => {
  it.each([
    ['no stored version', null, 0, 'apply'],
    ['no stored version, higher incoming', null, 7, 'apply'],
    ['lower stored version', 3, 4, 'apply'],
    ['much lower stored version', 0, 2 ** 53 - 1, 'apply'],
    ['equal versions', 5, 5, 'duplicate'],
    ['equal at zero', 0, 0, 'duplicate'],
    ['higher stored version', 6, 5, 'stale'],
    ['higher stored version, incoming zero', 1, 0, 'stale'],
  ])('S53 AS-71: %s → %s', (_label, stored, incoming, expected) => {
    expect(applyIfNewer(stored, incoming)).toBe(expected);
  });

  it.each([
    ['negative incoming', 1, -1],
    ['fractional incoming', 1, 1.5],
    ['NaN incoming', 1, Number.NaN],
    ['Infinity incoming', 1, Number.POSITIVE_INFINITY],
    ['above 2^53-1', 1, 2 ** 53],
    ['negative stored', -1, 1],
    ['fractional stored', 0.5, 1],
  ])('S53 AS-71: %s is refused', (_label, stored, incoming) => {
    expect(() => applyIfNewer(stored, incoming)).toThrow(RangeError);
  });

  it('S53 AS-71: any order of any versions converges to the maximum, and the maximum is applied at most once (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 50 }), {
          minLength: 1,
          maxLength: 40,
        }),
        (versions) => {
          let stored: number | null = null;
          let applied = 0;
          for (const incoming of versions) {
            if (applyIfNewer(stored, incoming) === 'apply') {
              stored = incoming;
              applied++;
            }
          }
          expect(stored).toBe(Math.max(...versions));
          // every application raised the stored version strictly
          expect(applied).toBeLessThanOrEqual(new Set(versions).size);
        },
      ),
    );
  });

  it('S53 AS-71: replaying the same sequence twice changes nothing the second time (idempotent)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 20 }), {
          minLength: 1,
          maxLength: 30,
        }),
        (versions) => {
          const run = (start: number | null) => {
            let stored = start;
            for (const v of versions)
              if (applyIfNewer(stored, v) === 'apply') stored = v;
            return stored;
          };
          const once = run(null);
          expect(run(once)).toBe(once);
        },
      ),
    );
  });
});
