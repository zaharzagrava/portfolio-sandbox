import { courierLocationsReportedPayloadSchema } from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';

/** One event per ingest batch (≤ 20 points), key = city. Consumer: DynamoDB track. */
export const CourierLocationsReported = defineEvent(
  'courier.locations_reported',
  'courier',
  1,
  courierLocationsReportedPayloadSchema,
);
