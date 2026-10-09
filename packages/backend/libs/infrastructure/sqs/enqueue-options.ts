import type { EnqueueOptions } from './task-queue.port';

export const MAX_DELAY_SECONDS = 900;

export class InvalidEnqueueOptionsError extends Error {
  constructor(
    readonly queue: string,
    readonly problems: string[],
  ) {
    super(`invalid enqueue options for ${queue}: ${problems.join('; ')}`);
    this.name = 'InvalidEnqueueOptionsError';
  }
}

/** Checks the options a producer passes before any request is made (S53 FR-060). */
export function validateEnqueueOptions(
  queue: string,
  options: EnqueueOptions = {},
): void {
  const fifo = queue.endsWith('.fifo');
  const problems: string[] = [];
  const { delaySeconds, groupId, dedupeId } = options;

  if (delaySeconds !== undefined) {
    if (
      !Number.isInteger(delaySeconds) ||
      delaySeconds < 0 ||
      delaySeconds > MAX_DELAY_SECONDS
    )
      problems.push(
        `delaySeconds must be an integer from 0 to ${MAX_DELAY_SECONDS}, got ${delaySeconds}`,
      );
    if (fifo && groupId !== undefined && delaySeconds > 0)
      problems.push('delaySeconds cannot be combined with a FIFO groupId');
  }
  if (fifo) {
    if (groupId === undefined || groupId === '')
      problems.push('a FIFO queue needs a non-empty groupId');
  } else {
    if (groupId !== undefined) problems.push('groupId is for FIFO queues only');
    if (dedupeId !== undefined)
      problems.push('dedupeId is for FIFO queues only');
  }
  if (fifo && dedupeId === '') problems.push('dedupeId must not be empty');

  if (problems.length) throw new InvalidEnqueueOptionsError(queue, problems);
}
