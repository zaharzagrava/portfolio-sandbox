export type RetryProfile = 'sync' | 'background';

export interface RetryOptions {
  /** `sync` serves a user request (at most 3 attempts); `background` runs in a job or consumer (at most 6). Default `sync`. */
  profile?: RetryProfile;
  /** Total attempts including the first. */
  maxAttempts?: number;
}

const ATTEMPT_CAP: Record<RetryProfile, number> = { sync: 3, background: 6 };

export class RetryOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryOptionsError';
  }
}

/** The number of attempts a call may make; refuses a value the profile does not allow (FR-056). */
export function resolveMaxAttempts({
  profile = 'sync',
  maxAttempts,
}: RetryOptions): number {
  const cap = ATTEMPT_CAP[profile];
  if (maxAttempts === undefined) return cap;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > cap) {
    throw new RetryOptionsError(
      `maxAttempts must be an integer from 1 to ${cap} in the ${profile} profile`,
    );
  }
  return maxAttempts;
}
