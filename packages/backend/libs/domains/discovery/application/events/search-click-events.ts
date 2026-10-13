import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/**
 * `search.result_clicked` v1 on `search.events`, keyed by the search's id (S32 AS-70). Strict, like the contract in
 * `packages/contracts`: the click consumer dead-letters anything else (AS-72).
 */
export const SearchResultClicked = defineEvent(
  'search.result_clicked',
  'search',
  1,
  z
    .object({
      searchId: z.string().min(1),
      query: z.string(),
      productId: z.string().uuid(),
      position: z.number().int().min(0).max(99),
    })
    .strict(),
);
