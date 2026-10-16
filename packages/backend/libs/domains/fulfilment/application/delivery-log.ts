import type { Logger } from '@nestjs/common';

/**
 * The structured log line of the delivery capability (S20 FR-047, A27): an event name plus the identifiers that tie the
 * line to a delivery, a courier and a city. Only these named fields can be logged - there is no free-form payload, so a
 * coordinate, an address or a token cannot reach a log through this helper. `requestId`, `traceId` and the actor come
 * from the request context the logger already merges in.
 */
export interface DeliveryLogFields {
  deliveryId?: string;
  courierId?: string;
  shopId?: string;
  city?: string;
  attempt?: number;
  status?: string;
  /** What went wrong, as `errorText` renders it. */
  error?: string;
  /** Which step of a multi-step flow, for example the label of a failed after-commit effect. */
  step?: string;
}

/** A decimal number with four or more fractional digits is a coordinate (or looks like one); it never reaches a log. */
const COORDINATE = /-?\d{1,3}\.\d{4,}/g;

/** The message of an error, with anything that looks like a coordinate removed. */
export const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replace(COORDINATE, '[number]')
    .slice(0, 300);

export function logDelivery(
  logger: Logger,
  level: 'log' | 'warn' | 'error',
  event: string,
  fields: DeliveryLogFields = {},
): void {
  logger[level]({ event, ...fields });
}
