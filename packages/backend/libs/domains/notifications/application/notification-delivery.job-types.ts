import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { NOTIFICATION_TYPES } from '../domain/catalog';
import type { DeliveryMessage } from '../domain/types';

// Kept apart from the handler (infra/notification-workers.service.ts) so an app that only enqueues loads the
// declaration without the worker code.
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    /** Quiet-hours delays longer than SQS's 15-minute max. */
    'notifications.deliver': { queue: string; message: DeliveryMessage };
  }
}

type NotificationTypeName = DeliveryMessage['type'];

declareJobType({
  name: 'notifications.deliver',
  contract: z.object({
    queue: z.string(),
    message: z.object({
      deliveryId: z.string(),
      userId: z.string(),
      type: z.enum(
        Object.keys(NOTIFICATION_TYPES) as [
          NotificationTypeName,
          ...NotificationTypeName[],
        ],
      ),
      channel: z.enum(['email', 'sms', 'push']),
      priority: z.enum(['transactional', 'marketing']),
      to: z.array(z.string()),
      subject: z.string(),
      html: z.string(),
      title: z.string(),
      body: z.string(),
      link: z.string(),
      unsubscribeUrl: z.string().optional(),
    }),
  }),
});
