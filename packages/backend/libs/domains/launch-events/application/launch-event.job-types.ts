import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handlers (infra/jobs) so an app that only enqueues loads the declarations without the worker code.
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    /** Frees a hold at `expiresAt`; safe to run late, twice or against a confirm. */
    'launch-events.expire-hold': { holdId: string };
    /** `SCHEDULED → ON_SALE` at `salesOpenAt`. */
    'launch-events.open-sales': { eventId: string };
    /** `→ CLOSED` at `startsAt` (reason `started`), and the organizer close's clean-up fan-out. */
    'launch-events.close-event': {
      eventId: string;
      reason: 'organizer' | 'started';
    };
    /** Every minute: repairs ledger, seat map and bookings drift. */
    'launch-events.reconcile-seats': Record<string, never>;
  }
}

declareJobType({
  name: 'launch-events.expire-hold',
  contract: z.object({ holdId: z.string().uuid() }).strict(),
});
declareJobType({
  name: 'launch-events.open-sales',
  contract: z.object({ eventId: z.string().uuid() }).strict(),
});
declareJobType({
  name: 'launch-events.close-event',
  contract: z
    .object({
      eventId: z.string().uuid(),
      reason: z.enum(['organizer', 'started']),
    })
    .strict(),
});
declareJobType({
  name: 'launch-events.reconcile-seats',
  contract: z.object({}).strict(),
});
