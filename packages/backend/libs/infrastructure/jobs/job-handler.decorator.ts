import { SetMetadata } from '@nestjs/common';
import type { JobHandlerOptions } from './handler-options';
import { JobType } from './job-types';

export type { JobHandlerOptions } from './handler-options';

export const JOB_HANDLER_METADATA = 'jobs:handler';

/**
 * Marks a provider method as the handler of a job type. Discovered at boot
 * by JobRegistry, so domains own their handlers without editing the worker.
 * Options are validated at boot (handler-options.ts); invalid ones abort startup.
 */
export const JobHandler = (type: JobType, options: JobHandlerOptions = {}) =>
  SetMetadata(JOB_HANDLER_METADATA, { type, ...options });
