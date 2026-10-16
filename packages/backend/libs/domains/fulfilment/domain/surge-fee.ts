/**
 * Surge and fee math in integer arithmetic (S20 R-7, A5): the multiplier is held in hundredths (100 = 1.00x ... 300 =
 * 3.00x in steps of 25) and `fee = (base x surge + 50) / 100` with integer division, which is round half up. No float
 * reaches the money path.
 */
export const BASE_FEE_MINOR = 499;
export const SURGE_MIN = 100;
export const SURGE_MAX = 300;
export const SURGE_STEP = 25;

export function isSurgeStep(surge: number): boolean {
  return (
    Number.isInteger(surge) &&
    surge >= SURGE_MIN &&
    surge <= SURGE_MAX &&
    (surge - SURGE_MIN) % SURGE_STEP === 0
  );
}

/** Fee in minor units of the order's currency for a surge in hundredths. */
export function feeForSurge(
  surgeHundredths: number,
  baseMinor: number = BASE_FEE_MINOR,
): number {
  if (!isSurgeStep(surgeHundredths))
    throw new RangeError(
      `surge ${surgeHundredths} is not a step of 0.25 in 1.00..3.00`,
    );
  return Math.floor((baseMinor * surgeHundredths + 50) / 100);
}

/**
 * Surge of a cell from demand (requests in the last 10 minutes) over eligible supply (at least 1), rounded half up to
 * quarter steps and clamped to 1.00..3.00. `null` when the result is 1.00 or below: such a cell has no entry.
 */
export function surgeFromRatio(demand: number, supply: number): number | null {
  const divisor = Math.max(1, supply);
  // round_half_up(demand * 4 / divisor) in integers
  const quarters = Math.floor((demand * 8 + divisor) / (2 * divisor));
  const surge = Math.min(SURGE_MAX, quarters * SURGE_STEP);
  return surge > SURGE_MIN ? surge : null;
}

/** The `surge` column / API value (`1`, `1.25` ... `3`) from hundredths. */
export const surgeToMultiplier = (surgeHundredths: number): number =>
  surgeHundredths / 100;
