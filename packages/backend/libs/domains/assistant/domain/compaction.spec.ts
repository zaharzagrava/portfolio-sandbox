import {
  COMPACTION_COUNT_RATIO,
  COMPACTION_THRESHOLD_TOKENS,
  decideCompaction,
  estimateTokens,
} from './compaction';

describe('S46 AS-59: compaction decision', () => {
  it('S46 AS-59: constants', () => {
    expect(COMPACTION_THRESHOLD_TOKENS).toBe(60_000);
    expect(COMPACTION_COUNT_RATIO).toBe(0.8);
  });

  it('S46 AS-37: estimateTokens is ceil(chars / 4)', () => {
    expect([0, 1, 4, 5, 8, 9].map(estimateTokens)).toEqual([0, 1, 1, 2, 2, 3]);
  });

  it.each([
    [
      'far below 80%: estimate decides, no count call',
      10_000,
      undefined,
      false,
      false,
    ],
    ['just below 80%: no count call', 47_999, undefined, false, false],
    ['at 80%: precise count says below', 48_000, 59_000, false, true],
    [
      'at 80%: precise count says exactly the threshold (not above)',
      48_000,
      60_000,
      false,
      true,
    ],
    ['at 80%: precise count says above', 48_000, 60_001, true, true],
    [
      'estimate above but the count says below: the count wins',
      70_000,
      50_000,
      false,
      true,
    ],
    [
      'estimate below threshold but count above: the count wins',
      55_000,
      61_000,
      true,
      true,
    ],
  ])('S46 AS-59: %s', async (_n, estimate, counted, compact, usedCount) => {
    const count = jest.fn(async () => counted ?? 0);
    const decision = await decideCompaction(estimate, count);
    expect(decision).toEqual({
      compact,
      usedCount,
      tokens: usedCount ? counted : estimate,
    });
    expect(count).toHaveBeenCalledTimes(usedCount ? 1 : 0);
  });

  it.each([
    ['estimate above the threshold -> compacts', 61_000, true],
    ['estimate at the threshold -> does not', 60_000, false],
    [
      'estimate in the count band but below the threshold -> does not',
      50_000,
      false,
    ],
  ])(
    'S46 AS-59: count failure falls back to the estimate (%s)',
    async (_n, estimate, compact) => {
      const count = jest.fn(async () => {
        throw new Error('provider down');
      });
      const decision = await decideCompaction(estimate, count);
      expect(decision).toEqual({ compact, usedCount: false, tokens: estimate });
      expect(count).toHaveBeenCalledTimes(1);
    },
  );
});
