import { z } from 'zod';

/** The numbers of the seller discount functions (S45 research D-03, VIII.5): validated once at start, read from here only. */
const int = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const schema = z.object({
  /** Budget of one function per checkout call. */
  functionBudgetMs: int(1, 1_000, 5),
  /** Budget of the whole `evaluateDiscounts` call. */
  callBudgetMs: int(10, 2_000, 200),
  /** Budget of one judge case and of a whole version. */
  caseBudgetMs: int(1, 1_000, 50),
  versionBudgetMs: int(100, 60_000, 10_000),
  isolateMemoryMb: int(8, 128, 32),
  outputMaxBytes: int(1_024, 1_048_576, 64 * 1024),
  suiteMaxBytes: int(1_024, 4_194_304, 256 * 1024),
  /** TTL of the active-set cache and of memoised results. */
  cacheTtlSec: int(1, 3_600, 60),
  breakerFailures: int(1, 100, 5),
  breakerWindowMs: int(1_000, 600_000, 60_000),
  breakerOpenMs: int(1_000, 3_600_000, 300_000),
  /** Empty isolates kept ready, and isolates alive at once. */
  poolSize: int(0, 32, 4),
  semaphore: int(1, 64, 8),
  judgeConcurrency: int(1, 32, 4),
  maxFunctionsPerShop: int(1, 100, 3),
  maxVersionsPerFunction: int(1, 10_000, 100),
  submitsPerHour: int(1, 10_000, 10),
  /** A version stuck this long is re-requested; this many attempts, then rejected. */
  stuckAfterMs: int(1_000, 3_600_000, 120_000),
  maxJudgeAttempts: int(1, 50, 5),
});

export type ShopFunctionsSettings = z.infer<typeof schema>;

export class ShopFunctionsConfigError extends Error {
  constructor(readonly keys: string[]) {
    super(`Invalid shop-functions configuration: ${keys.join(', ')}`);
    this.name = 'ShopFunctionsConfigError';
  }
}

/** Pure: settings from raw values (`SHOP_FUNCTIONS_<NAME>` upper snake case); every violation names its key, never the value. */
export function parseShopFunctionsConfig(
  values: Record<string, unknown> = {},
): ShopFunctionsSettings {
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(schema.shape)) {
    const env = `SHOP_FUNCTIONS_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
    const value = values[env];
    raw[key] = value === '' || value === null ? undefined : value;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new ShopFunctionsConfigError([
      ...new Set(parsed.error.issues.map((i) => String(i.path[0]))),
    ]);
  return parsed.data;
}

/** Injectable settings; tests override the provider with their own values. */
export class ShopFunctionsConfig implements ShopFunctionsSettings {
  readonly functionBudgetMs!: number;
  readonly callBudgetMs!: number;
  readonly caseBudgetMs!: number;
  readonly versionBudgetMs!: number;
  readonly isolateMemoryMb!: number;
  readonly outputMaxBytes!: number;
  readonly suiteMaxBytes!: number;
  readonly cacheTtlSec!: number;
  readonly breakerFailures!: number;
  readonly breakerWindowMs!: number;
  readonly breakerOpenMs!: number;
  readonly poolSize!: number;
  readonly semaphore!: number;
  readonly judgeConcurrency!: number;
  readonly maxFunctionsPerShop!: number;
  readonly maxVersionsPerFunction!: number;
  readonly submitsPerHour!: number;
  readonly stuckAfterMs!: number;
  readonly maxJudgeAttempts!: number;

  constructor(settings: ShopFunctionsSettings = parseShopFunctionsConfig({})) {
    Object.assign(this, settings);
  }

  static fromEnv(env: Record<string, unknown> = process.env) {
    return new ShopFunctionsConfig(parseShopFunctionsConfig(env));
  }
}
