import * as joi from 'joi';
import { ConfigRules, RuleCheck } from './config-rules';

/**
 * Validated settings of the job scheduler (S49 R-09). Defaults are applied here (the loader keeps the raw value);
 * every number must be a positive integer.
 */
export interface JobsConfig {
  /** Largest number of jobs one worker claims per poll. */
  jobs_claim_batch: number;
  /** Most RUNNING jobs per shop across the whole fleet. */
  jobs_per_shop_running_cap: number;
  /** Days finished job rows and keys are kept. */
  jobs_retain_days: number;
  /** Sleep between claims when the queue is empty. */
  jobs_poll_idle_ms: number;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const int = (name: string, fallback: number, max?: number): Key => {
  let verify = joi.number().integer().min(1);
  if (max !== undefined) verify = verify.max(max);
  return {
    name,
    verify: verify.required(),
    postProcess: ((v: unknown) =>
      v === undefined ? fallback : Number(v)) as never,
  };
};

export const jobsConfigKeys: Record<keyof JobsConfig, Key> = {
  jobs_claim_batch: int('JOBS_CLAIM_BATCH', 50, 1_000),
  jobs_per_shop_running_cap: int('JOBS_PER_SHOP_RUNNING_CAP', 5),
  jobs_retain_days: int('JOBS_RETAIN_DAYS', 30, 3_650),
  jobs_poll_idle_ms: int('JOBS_POLL_IDLE_MS', 500, 60_000),
};

/** A claim batch above ten times the connection pool would hold more jobs than the instance can ever run. */
export const jobsConfigRule: RuleCheck = (ctx) => {
  const batch = ctx.get('jobs_claim_batch');
  const pool = ctx.get('db_pool_max');
  return typeof batch === 'number' &&
    typeof pool === 'number' &&
    pool > 0 &&
    batch > pool * 10
    ? ['jobs_claim_batch must not exceed db_pool_max × 10']
    : [];
};

ConfigRules.register({
  owner: 'jobs',
  keys: ['jobs_claim_batch', 'db_pool_max'],
  validate: jobsConfigRule,
});
