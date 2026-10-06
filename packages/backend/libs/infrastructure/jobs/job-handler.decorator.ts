import { SetMetadata } from '@nestjs/common';
import { JobType } from './job-types';

export const JOB_HANDLER_METADATA = 'jobs:handler';

export interface JobHandlerOptions {
  /** Lease length; the worker heartbeats at half of it. */
  leaseMs?: number;
  /** Per-type concurrency cap on one worker instance (bulkhead). */
  concurrency?: number;
}

/**
 * Marks a provider method as the handler of a job type. Discovered at boot
 * by JobRegistry, so domains own their handlers without editing the worker.
 */
export const JobHandler = (type: JobType, options: JobHandlerOptions = {}) =>
  SetMetadata(JOB_HANDLER_METADATA, { type, ...options });
