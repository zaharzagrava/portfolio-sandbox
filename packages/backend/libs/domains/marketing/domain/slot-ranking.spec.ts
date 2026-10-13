import fc from 'fast-check';
import { selectSlots, type SlotCandidate } from './slot-ranking';

/** A deterministic permutation (Fisher-Yates over a small LCG), so a failing case replays from its seed. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const c = (campaignId: string, shopId: string, cpcMinor: number) => ({
  campaignId,
  shopId,
  cpcMinor,
});

describe('S36 AS-23: slot ranking', () => {
  it.each([
    [
      'sorted by CPC descending',
      [c('a', 's1', 10), c('b', 's2', 30), c('c', 's3', 20)],
      3,
      ['b', 'c', 'a'],
    ],
    [
      'equal CPC ordered by campaign id ascending',
      [c('z', 's1', 30), c('m', 's2', 30), c('a', 's3', 30)],
      3,
      ['a', 'm', 'z'],
    ],
    [
      'one per shop, the best CPC of the shop is kept',
      [c('a', 's1', 35), c('b', 's1', 40), c('c', 's2', 30), c('d', 's3', 30)],
      3,
      ['b', 'c', 'd'],
    ],
    [
      'the same shop and CPC keeps the lower campaign id',
      [c('y', 's1', 30), c('x', 's1', 30)],
      3,
      ['x'],
    ],
    [
      'cut to limit',
      [c('a', 's1', 3), c('b', 's2', 2), c('c', 's3', 1)],
      1,
      ['a'],
    ],
    ['no candidates', [], 3, []],
  ])('%s', (_name, input, limit, expected) => {
    expect(
      selectSlots(input as SlotCandidate[], limit as number).map(
        (x) => x.campaignId,
      ),
    ).toEqual(expected);
  });

  const candidate = fc.record({
    campaignId: fc.uuid(),
    shopId: fc.constantFrom('s1', 's2', 's3', 's4'),
    cpcMinor: fc.integer({ min: 1, max: 40 }),
  });

  it('property: at most limit, one per shop, ordered, order independent, best of each shop', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(candidate, { selector: (x) => x.campaignId }),
        fc.integer({ min: 1, max: 3 }),
        fc.integer(),
        (candidates, limit, seed) => {
          const out = selectSlots(candidates, limit);
          expect(out.length).toBeLessThanOrEqual(limit);
          expect(new Set(out.map((x) => x.shopId)).size).toBe(out.length);
          for (let i = 1; i < out.length; i++) {
            const [p, q] = [out[i - 1], out[i]];
            expect(
              p.cpcMinor > q.cpcMinor ||
                (p.cpcMinor === q.cpcMinor && p.campaignId < q.campaignId),
            ).toBe(true);
          }
          // the kept candidate of a shop is its best one
          for (const kept of out) {
            const best = candidates
              .filter((x) => x.shopId === kept.shopId)
              .sort(
                (a, b) =>
                  b.cpcMinor - a.cpcMinor ||
                  (a.campaignId < b.campaignId ? -1 : 1),
              )[0];
            expect(kept.campaignId).toBe(best.campaignId);
          }
          // any permutation gives the same output
          expect(selectSlots(shuffle(candidates, seed), limit)).toEqual(out);
        },
      ),
      { seed: 36, numRuns: 200 },
    );
  });
});
