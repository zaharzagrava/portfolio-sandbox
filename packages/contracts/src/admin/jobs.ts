import { z } from 'zod';

/** J01 control surface: job types an administrator may enqueue over HTTP. */
export const ADMIN_JOB_TYPES = ['payouts.run-weekly', 'statements.close-month', 'payments.reconcile-daily'] as const;
export const adminJobTypeSchema = z.enum(ADMIN_JOB_TYPES);

export const adminJobStatusSchema = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD']);

export const createAdminJobSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const adminJobAcceptedSchema = z.object({ jobId: z.string().min(1) });

export const adminJobSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  status: adminJobStatusSchema,
  attempts: z.number().int().min(0),
  finishedAt: z.iso.datetime().nullable(),
});

export type AdminJobType = z.infer<typeof adminJobTypeSchema>;
export type AdminJobStatus = z.infer<typeof adminJobStatusSchema>;
export type CreateAdminJob = z.infer<typeof createAdminJobSchema>;
export type AdminJob = z.infer<typeof adminJobSchema>;
