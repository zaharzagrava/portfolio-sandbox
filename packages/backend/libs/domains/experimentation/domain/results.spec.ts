import { experimentResultsSchema } from '@marketplace-sandbox/contracts';
import {
  CROSSOVER_THRESHOLD,
  MIN_ARM_UNITS,
  SRM_P_THRESHOLD,
  alphaFor,
  assembleResults,
  type ResultsInput,
} from './results';
import type { ResultsCounts } from './ports';

const ASOF = new Date('2026-10-14T12:00:00.000Z');
const STARTED = new Date('2026-10-14T09:00:00.000Z');

const input = (
  counts: Partial<ResultsCounts> & { variants?: ResultsCounts['variants'] },
  patch: Partial<ResultsInput['experiment']> = {},
): ResultsInput => ({
  experiment: {
    key: 'free-shipping',
    version: 2,
    status: 'running',
    metric: 'purchase',
    unit: 'user',
    variants: [
      { key: 'control', weight: 5_000 },
      { key: 'free', weight: 5_000 },
    ],
    startedAt: STARTED,
    stoppedAt: null,
    ...patch,
  },
  counts: {
    variants: [
      { variant: 'control', exposures: 10_000, conversions: 1_000 },
      { variant: 'free', exposures: 10_000, conversions: 1_200 },
    ],
    crossoverUnits: 0,
    unattributable: 0,
    unknownVariant: 0,
    ...counts,
  },
  asOf: ASOF,
});

describe('Experiment results assembly', () => {
  it('S39 AS-45: the thresholds are one constant each', () => {
    expect(SRM_P_THRESHOLD).toBe(0.001);
    expect(CROSSOVER_THRESHOLD).toBe(0.01);
    expect(MIN_ARM_UNITS).toBe(100);
    expect(alphaFor(2)).toBe(0.05);
    expect(alphaFor(3)).toBe(0.025);
    expect(alphaFor(5)).toBeCloseTo(0.0125, 12);
  });

  it('S39 AS-42: a healthy readout carries every field and the comparison of each arm with control', () => {
    const results = assembleResults(input({}));
    expect(experimentResultsSchema.parse(results)).toEqual(results);
    expect(results).toMatchObject({
      experiment: 'free-shipping',
      version: 2,
      status: 'running',
      metric: 'purchase',
      unit: 'user',
      analysis: 'fixed_horizon',
      windowStart: STARTED.toISOString(),
      windowEnd: ASOF.toISOString(),
      asOf: ASOF.toISOString(),
      alpha: 0.05,
      trustworthy: true,
      problems: [],
      srm: { chiSquare: 0, pValue: 1, mismatch: false },
      excluded: { unattributable: 0, unknownVariant: 0, crossoverUnits: 0 },
    });
    expect(results.variants[0]).toEqual({
      variant: 'control',
      exposures: 10_000,
      conversions: 1_000,
      conversionRate: 0.1,
      comparison: 'control',
    });
    expect(results.variants[1]).toMatchObject({
      variant: 'free',
      exposures: 10_000,
      conversions: 1_200,
      conversionRate: 0.12,
      comparison: 'available',
    });
    expect(results.variants[1].vsControl).toMatchObject({
      significant: true,
      relativeLift: expect.closeTo(0.2, 12),
    });
  });

  it('S39 AS-42: the window of a stopped experiment ends at stoppedAt', () => {
    const stopped = new Date('2026-10-14T11:00:00.000Z');
    const results = assembleResults(
      input({}, { status: 'stopped', stoppedAt: stopped }),
    );
    expect(results.windowEnd).toBe(stopped.toISOString());
    expect(results.asOf).toBe(ASOF.toISOString());
  });

  it('S39 AS-45: a sample ratio mismatch makes the readout untrustworthy and withholds the comparison', () => {
    const results = assembleResults(
      input({
        variants: [
          { variant: 'control', exposures: 6_000, conversions: 600 },
          { variant: 'free', exposures: 4_000, conversions: 600 },
        ],
      }),
    );
    expect(results.srm.mismatch).toBe(true);
    expect(results.trustworthy).toBe(false);
    expect(results.problems).toEqual(['srm_mismatch']);
    expect(results.variants[1].comparison).toBe('withheld_untrustworthy');
    expect(results.variants[1]).not.toHaveProperty('vsControl');
    expect(results.variants[0].comparison).toBe('control');
  });

  it('S39 AS-28: crossover above 1 % of the exposed units is untrustworthy, 1 % exactly is not', () => {
    const exposed = (crossoverUnits: number) =>
      assembleResults(
        input({
          variants: [
            { variant: 'control', exposures: 4_950, conversions: 400 },
            { variant: 'free', exposures: 4_950, conversions: 500 },
          ],
          crossoverUnits,
        }),
      );
    // 9,900 counted + 100 crossover = 10,000 exposed units: 100 is exactly 1 %.
    expect(exposed(100).trustworthy).toBe(true);
    expect(exposed(100).problems).toEqual([]);
    const over = exposed(101);
    expect(over.problems).toEqual(['crossover_exceeds_threshold']);
    expect(over.variants[1].comparison).toBe('withheld_untrustworthy');
    expect(over.excluded.crossoverUnits).toBe(101);
  });

  it('S39 AS-45: both problems are listed, srm first', () => {
    const results = assembleResults(
      input({
        variants: [
          { variant: 'control', exposures: 6_000, conversions: 600 },
          { variant: 'free', exposures: 4_000, conversions: 600 },
        ],
        crossoverUnits: 2_000,
      }),
    );
    expect(results.problems).toEqual([
      'srm_mismatch',
      'crossover_exceeds_threshold',
    ]);
  });

  it('S39 AS-46: an arm under 100 units gives insufficient_sample for the others and keeps the counts', () => {
    const results = assembleResults(
      input({
        variants: [
          { variant: 'control', exposures: 99, conversions: 10 },
          { variant: 'free', exposures: 99, conversions: 20 },
        ],
      }),
    );
    expect(results.variants.map((v) => v.exposures)).toEqual([99, 99]);
    expect(results.variants[1].comparison).toBe('insufficient_sample');
    expect(results.variants[1]).not.toHaveProperty('vsControl');
    expect(results.variants[1].conversionRate).toBeCloseTo(20 / 99, 12);
    const justEnough = assembleResults(
      input({
        variants: [
          { variant: 'control', exposures: 100, conversions: 10 },
          { variant: 'free', exposures: 100, conversions: 20 },
        ],
      }),
    );
    expect(justEnough.variants[1].comparison).toBe('available');
  });

  it('S39 AS-46: insufficient_sample outranks withheld_untrustworthy', () => {
    const results = assembleResults(
      input({
        variants: [
          { variant: 'control', exposures: 5_000, conversions: 500 },
          { variant: 'free', exposures: 50, conversions: 10 },
        ],
      }),
    );
    expect(results.srm.mismatch).toBe(true);
    expect(results.variants[1].comparison).toBe('insufficient_sample');
  });

  it('S39 AS-47: three variants test each arm at 0.025', () => {
    const results = assembleResults(
      input(
        {
          variants: [
            { variant: 'control', exposures: 3_400, conversions: 340 },
            { variant: 'a', exposures: 3_300, conversions: 400 },
            { variant: 'b', exposures: 3_300, conversions: 330 },
          ],
        },
        {
          variants: [
            { key: 'control', weight: 3_400 },
            { key: 'a', weight: 3_300 },
            { key: 'b', weight: 3_300 },
          ],
        },
      ),
    );
    expect(results.alpha).toBe(0.025);
    expect(results.variants[1].comparison).toBe('available');
    expect(results.variants[2].comparison).toBe('available');
  });

  it('S39 AS-50: no exposures at all is no_data with zero counts and a neutral SRM', () => {
    const results = assembleResults(
      input({
        variants: [
          { variant: 'control', exposures: 0, conversions: 0 },
          { variant: 'free', exposures: 0, conversions: 0 },
        ],
      }),
    );
    expect(results.trustworthy).toBe(true);
    expect(results.srm).toEqual({ chiSquare: 0, pValue: 1, mismatch: false });
    expect(results.variants.map((v) => v.comparison)).toEqual([
      'control',
      'no_data',
    ]);
    expect(results.variants.map((v) => v.conversionRate)).toEqual([0, 0]);
  });

  it('S39 AS-50: a draft has no window start and the same neutral shape', () => {
    const results = assembleResults(
      input(
        {
          variants: [
            { variant: 'control', exposures: 0, conversions: 0 },
            { variant: 'free', exposures: 0, conversions: 0 },
          ],
        },
        { status: 'draft', startedAt: null },
      ),
    );
    expect(results.status).toBe('draft');
    expect(results.windowStart).toBeNull();
    expect(results.windowEnd).toBe(ASOF.toISOString());
  });

  it('S39 AS-29: excluded counts are carried through', () => {
    const results = assembleResults(
      input({ unattributable: 7, unknownVariant: 3, crossoverUnits: 1 }),
    );
    expect(results.excluded).toEqual({
      unattributable: 7,
      unknownVariant: 3,
      crossoverUnits: 1,
    });
  });

  it('S39 AS-48: a zero control rate gives a null lift and no NaN anywhere', () => {
    const results = assembleResults(
      input({
        variants: [
          { variant: 'control', exposures: 1_000, conversions: 0 },
          { variant: 'free', exposures: 1_000, conversions: 30 },
        ],
      }),
    );
    expect(results.variants[1].vsControl?.relativeLift).toBeNull();
    expect(JSON.stringify(results)).not.toMatch(/NaN|Infinity/);
    expect(experimentResultsSchema.safeParse(results).success).toBe(true);
  });
});
