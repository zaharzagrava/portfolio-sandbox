import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/** One per public API call (key = shopId). ClickHouse request log + usage by version/route. */
export const ApiRequestLogged = defineEvent(
  'api.request_logged',
  'api',
  1,
  z.object({
    requestId: z.string(),
    shopId: z.string(),
    keyId: z.string(),
    livemode: z.boolean(),
    version: z.string(),
    method: z.string(),
    route: z.string(),
    status: z.number().int(),
    durationMs: z.number().int(),
    deprecated: z.boolean(),
  }),
);
