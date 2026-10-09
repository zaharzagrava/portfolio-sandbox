import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

export const SearchResultClicked = defineEvent(
  'search.result_clicked',
  'search',
  1,
  z.object({
    query: z.string(),
    productId: z.string(),
    position: z.number().int().min(0),
  }),
);
