import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

export const SearchPerformed = defineEvent(
  'search.performed',
  'search',
  1,
  z.object({
    query: z.string(),
    results: z.number().int().nonnegative(),
    /** Salted hash: counts distinct searchers without storing who searched what. */
    userHash: z.string(),
  }),
);
