export const JOBS_WORKER_OPTIONS = Symbol('JOBS_WORKER_OPTIONS');

export interface JobsWorkerOptions {
  /**
   * Start the claim, reaper and materialiser loops at application bootstrap (default true). Specs pass false and
   * drive `runOnce()` / the maintenance ticks by hand for determinism.
   */
  loops?: boolean;
}
