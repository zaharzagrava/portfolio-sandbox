import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/** `ledger.events` - drives the balance read model (F-05) and statements (SD-41). */
export const JournalPosted = defineEvent('ledger.journal_posted', 'ledger', 1, z.object({
  kind: z.string(),
  lines: z.array(z.object({ accountId: z.string(), amount: z.number().int() })),
}));
