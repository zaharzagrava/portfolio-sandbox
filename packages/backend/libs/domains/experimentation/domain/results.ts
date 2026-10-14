import type { ExperimentResults } from '@marketplace-sandbox/contracts';
import type { ExperimentStatus, ExperimentUnit } from './experiment-types';
import type { ResultsCounts } from './ports';
import { SRM_P_THRESHOLD, compareToControl, srmCheck } from './stats';

export { SRM_P_THRESHOLD };

/** Crossover units above this share of the exposed units make the readout untrustworthy (S39 FR-043). */
export const CROSSOVER_THRESHOLD = 0.01;
/** An arm with fewer exposed units than this is too small to compare (S39 FR-043). */
export const MIN_ARM_UNITS = 100;

/** Bonferroni: the family-wise 5 % shared by every comparison with control. */
export const alphaFor = (variantCount: number): number =>
  0.05 / Math.max(1, variantCount - 1);

export interface ResultsInput {
  experiment: {
    key: string;
    version: number;
    status: ExperimentStatus;
    metric: string;
    unit: ExperimentUnit;
    variants: { key: string; weight: number }[];
    startedAt: Date | null;
    stoppedAt: Date | null;
  };
  counts: ResultsCounts;
  asOf: Date;
}

/**
 * The readout of one experiment from the counts of one consistent read (S39 FR-040 – FR-044), pure. Per variant: units,
 * converted units and rate. The first variant is control; every other arm is compared with it unless the comparison
 * would mislead, decided in this order: nothing to compare (`no_data`), an arm too small (`insufficient_sample`), the
 * data broken by a sample ratio mismatch or too many crossover units (`withheld_untrustworthy`), else `available`.
 * Dates are stated, never read: `asOf` is the read time and the window of a stopped experiment ends at `stoppedAt`.
 */
export function assembleResults({
  experiment,
  counts,
  asOf,
}: ResultsInput): ExperimentResults {
  const byVariant = new Map(counts.variants.map((v) => [v.variant, v]));
  const arms = experiment.variants.map((variant) => {
    const found = byVariant.get(variant.key);
    const exposures = found?.exposures ?? 0;
    const conversions = found?.conversions ?? 0;
    return {
      key: variant.key,
      exposures,
      conversions,
      rate: exposures > 0 ? conversions / exposures : 0,
    };
  });
  const counted = arms.reduce((sum, arm) => sum + arm.exposures, 0);
  const srm = srmCheck(
    arms.map((arm) => arm.exposures),
    experiment.variants.map((v) => v.weight),
  );
  const exposedUnits = counted + counts.crossoverUnits;
  const crossoverShare =
    exposedUnits > 0 ? counts.crossoverUnits / exposedUnits : 0;
  const problems: ExperimentResults['problems'] = [];
  if (srm.mismatch) problems.push('srm_mismatch');
  if (crossoverShare > CROSSOVER_THRESHOLD)
    problems.push('crossover_exceeds_threshold');
  const trustworthy = problems.length === 0;
  const alpha = alphaFor(experiment.variants.length);
  const control = arms[0];
  const smallArm = arms.some((arm) => arm.exposures < MIN_ARM_UNITS);

  return {
    experiment: experiment.key,
    version: experiment.version,
    status: experiment.status,
    metric: experiment.metric,
    unit: experiment.unit,
    analysis: 'fixed_horizon',
    windowStart: experiment.startedAt?.toISOString() ?? null,
    windowEnd: (experiment.stoppedAt ?? asOf).toISOString(),
    asOf: asOf.toISOString(),
    alpha,
    trustworthy,
    problems,
    srm,
    excluded: {
      unattributable: counts.unattributable,
      unknownVariant: counts.unknownVariant,
      crossoverUnits: counts.crossoverUnits,
    },
    variants: arms.map((arm, index) => {
      const row = {
        variant: arm.key,
        exposures: arm.exposures,
        conversions: arm.conversions,
        conversionRate: arm.rate,
      };
      if (index === 0) return { ...row, comparison: 'control' as const };
      if (counted === 0) return { ...row, comparison: 'no_data' as const };
      if (smallArm)
        return { ...row, comparison: 'insufficient_sample' as const };
      if (!trustworthy)
        return { ...row, comparison: 'withheld_untrustworthy' as const };
      return {
        ...row,
        comparison: 'available' as const,
        vsControl: compareToControl(
          { conversions: control.conversions, exposures: control.exposures },
          { conversions: arm.conversions, exposures: arm.exposures },
          alpha,
        ),
      };
    }),
  };
}
