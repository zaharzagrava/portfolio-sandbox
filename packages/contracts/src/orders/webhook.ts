import { z } from 'zod';

export const WEBHOOK_BODY_LIMIT_BYTES = 65_536;

export const webhookAckSchema = z
  .object({ received: z.literal(true), duplicate: z.literal(true).optional() })
  .strict();
