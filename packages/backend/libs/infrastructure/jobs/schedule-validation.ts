import { IANAZone } from 'luxon';
import { isValidCron } from './cron';
import { isValidAttempts } from './enqueue-options';
import { InvalidScheduleError } from './job-errors';

export const SCHEDULE_NAME_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
export const MAX_SCHEDULE_NAME_LENGTH = 100;

export interface ScheduleInput {
  name: string;
  cron: string;
  timezone?: string;
  maxAttempts?: number;
  overlap?: 'skip' | 'allow';
}

/** Throws `InvalidScheduleError{field}` for the first broken rule; nothing is written before this passes. */
export function validateScheduleInput(input: ScheduleInput): void {
  const { name, cron, timezone = 'UTC', maxAttempts, overlap } = input;
  if (
    typeof name !== 'string' ||
    name.length > MAX_SCHEDULE_NAME_LENGTH ||
    !SCHEDULE_NAME_PATTERN.test(name)
  )
    throw new InvalidScheduleError(
      'name',
      `lower-case words joined by . _ or -, at most ${MAX_SCHEDULE_NAME_LENGTH} characters`,
    );
  if (typeof timezone !== 'string' || !IANAZone.isValidZone(timezone))
    throw new InvalidScheduleError('timezone', 'not an IANA time zone');
  if (typeof cron !== 'string' || !isValidCron(cron, timezone))
    throw new InvalidScheduleError(
      'cron',
      'expected 5 fields, or 6 with seconds, that fire at least once (no L, W, #)',
    );
  if (maxAttempts !== undefined && !isValidAttempts(maxAttempts))
    throw new InvalidScheduleError('maxAttempts', 'integer 1 to 25');
  if (overlap !== undefined && overlap !== 'skip' && overlap !== 'allow')
    throw new InvalidScheduleError('overlap', 'skip or allow');
}
