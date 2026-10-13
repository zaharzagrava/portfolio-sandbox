import type { Clock } from '@app/common/core/clock';

/**
 * Attributes of a `video-transcode` message: the request and trace ids of whoever caused it (so the worker's log lines
 * join the same trace) and `sentAt`, the instant it was sent, from which the worker measures how long it waited
 * (`video_queue_age_seconds`). Only these keys: nothing else travels with a message.
 */
export function messageAttributes(
  clock: Clock,
  trace: Record<string, string> = {},
): Record<string, string> {
  const { requestId, traceId } = trace;
  return {
    ...(requestId && { requestId }),
    ...(traceId && { traceId }),
    sentAt: String(clock.nowMs()),
  };
}

/** Seconds the message waited, or null when it carries no usable `sentAt`. */
export function queueAgeSeconds(
  clock: Clock,
  attributes: Record<string, string>,
): number | null {
  const sentAt = Number(attributes.sentAt);
  return Number.isFinite(sentAt) && sentAt > 0
    ? Math.max(0, (clock.nowMs() - sentAt) / 1000)
    : null;
}
