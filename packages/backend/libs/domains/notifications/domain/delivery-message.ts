import { z } from 'zod';
import type { DeliveryMessage } from './types';

/**
 * Shape of a message on a delivery line. The line is an input boundary like any other: a body that fails this is
 * dead-lettered as `invalid_message` and never reaches a provider (FR-032, AS-50).
 */
export const deliveryMessageSchema: z.ZodType<DeliveryMessage> = z.object({
  deliveryId: z.string().min(1).max(200),
  userId: z.string().max(200),
  type: z.string().min(1).max(100) as z.ZodType<DeliveryMessage['type']>,
  channel: z.enum(['email', 'sms', 'push']),
  priority: z.enum(['transactional', 'marketing']),
  to: z.array(z.string().min(1).max(4096)).max(100),
  subject: z.string(),
  html: z.string(),
  title: z.string(),
  body: z.string(),
  link: z.string(),
  unsubscribeUrl: z.string().optional(),
  staleAt: z.string().optional(),
  routedAt: z.string().optional(),
});
