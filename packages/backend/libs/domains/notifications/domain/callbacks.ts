import { z } from 'zod';

/**
 * What an accepted provider callback looks like on the queue `notifications-callbacks` (FR-043, FR-045). The intake
 * verifies the provider's signature and reduces the callback to this; the worker applies it. The queue is an input
 * boundary like any other: a body that fails this is dead-lettered as `invalid_message`.
 */
const email = z.string().min(1).max(320);

export const sesCallbackSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('delivery'),
    messageId: z.string().min(1).max(200),
    recipients: z.array(email).max(50),
  }),
  z.object({
    kind: z.literal('bounce'),
    messageId: z.string().min(1).max(200),
    bounceType: z.enum(['Permanent', 'Transient', 'Undetermined']),
    recipients: z.array(email).max(50),
  }),
  z.object({
    kind: z.literal('complaint'),
    messageId: z.string().min(1).max(200),
    recipients: z.array(email).max(50),
  }),
]);

export const smsCallbackSchema = z.object({
  kind: z.literal('status'),
  messageId: z.string().min(1).max(200),
  status: z.string().min(1).max(40),
  errorCode: z.string().max(20).optional(),
  to: z.string().max(40).optional(),
});

const base = {
  /** The provider's own event identity: the deduplication id. */
  eventId: z.string().min(1).max(300),
  /** When we durably accepted it; the early-callback retry window (10 minutes) counts from here. */
  acceptedAt: z.string().datetime(),
};

export const callbackMessageSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('ses'), ...base, payload: sesCallbackSchema }),
  z.object({
    provider: z.literal('twilio'),
    ...base,
    payload: smsCallbackSchema,
  }),
]);

export type SesCallback = z.infer<typeof sesCallbackSchema>;
export type SmsCallback = z.infer<typeof smsCallbackSchema>;
export type CallbackMessage = z.infer<typeof callbackMessageSchema>;

/** A callback that raced our own timeline write is retried for this long, then dropped with a counter (AS-72). */
export const EARLY_CALLBACK_WINDOW_MS = 10 * 60_000;
/** Delay before re-checking a callback whose provider message id is not mapped yet: 5 s, doubling, at most 60 s. */
export const earlyCallbackDelaySeconds = (attempt: number): number =>
  Math.min(5 * 2 ** Math.max(attempt - 1, 0), 60);

/** Queue attribute carrying how many times a callback was re-queued while waiting for our own timeline record. */
export const CALLBACK_ATTEMPT_ATTRIBUTE = 'attempt';

/** SNS signing certificates and subscription URLs come from `sns.<region>.amazonaws.com` over HTTPS only. */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export function isSnsHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && SNS_HOST.test(url.hostname);
}
