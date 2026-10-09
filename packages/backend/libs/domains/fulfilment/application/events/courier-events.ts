import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

/** One event per ingest batch (≤ 20 points), key = city. Consumer: DynamoDB track. */
export const CourierLocationsReported = defineEvent(
  'courier.locations_reported',
  'courier',
  1,
  z.object({
    courierId: z.string(),
    city: z.string(),
    deliveryId: z.string().nullable(),
    points: z.array(
      z.object({
        lat: z.number(),
        lng: z.number(),
        ts: z.number().int(),
        accuracy: z.number().optional(),
      }),
    ),
  }),
);
