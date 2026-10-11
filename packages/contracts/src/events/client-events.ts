import { z } from 'zod';

/**
 * Browser analytics batch accepted by `POST /events` (S39; backend `ClientEvent`/`ClientBatch` in
 * `experimentation/domain/event-schema.ts`). `video_view` is added by the S39 spec (consumer S30).
 */
export const CLIENT_EVENT_NAMES = [
  'page_view',
  'product_view',
  'search',
  'add_to_cart',
  'checkout_step',
  'exposure',
  'click',
  'video_view',
] as const;

export const clientEventSchema = z.object({
  event_id: z.uuid(),
  name: z.enum(CLIENT_EVENT_NAMES),
  anonymous_id: z.string().min(8).max(64),
  ts: z.number().int(),
  page: z.string().max(500).optional(),
  props: z
    .record(
      z.string().max(64),
      z.union([z.string().max(500), z.number(), z.boolean()]),
    )
    .refine((p) => Object.keys(p).length <= 30, 'max 30 props')
    .optional(),
});
export type ClientEventInput = z.infer<typeof clientEventSchema>;

export const clientEventBatchSchema = z.object({
  events: z.array(clientEventSchema).min(1).max(50),
});
export type ClientEventBatch = z.infer<typeof clientEventBatchSchema>;
