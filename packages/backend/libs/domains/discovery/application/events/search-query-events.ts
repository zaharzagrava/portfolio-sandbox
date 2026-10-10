import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * `search.performed` v1 on `search.events`, keyed by `searchId` (S32 AS-76). The fields added by S32 are optional here
 * only so rows that older code logged still parse; every event S32 emits carries all of them and parses with
 * `searchEventSchemas` from `packages/contracts`.
 */
export const SearchPerformed = defineEvent(
  'search.performed',
  'search',
  1,
  z.object({
    searchId: z.string().optional(),
    query: z.string(),
    results: z.number().int().nonnegative(),
    mode: z.enum(['browse', 'lexical', 'semantic']).optional(),
    /** Salted hash: counts distinct searchers without storing who searched what. */
    userHash: z.string(),
    /** Names of the filters used, never their values. */
    filters: z.array(z.string()).optional(),
    degraded: z.array(z.string()).optional(),
    surface: z.enum(['http', 'internal']).optional(),
  }),
);
