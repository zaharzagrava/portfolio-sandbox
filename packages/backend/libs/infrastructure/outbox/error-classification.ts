export type PublishErrorClass = 'retryable' | 'non-retryable';

/** Broker answers that no retry can fix: the message itself is rejected (FR-017, AS-19). */
const NON_RETRYABLE_PROTOCOL_TYPES = new Set([
  'MESSAGE_TOO_LARGE',
  'RECORD_LIST_TOO_LARGE',
  'INVALID_MESSAGE',
  'INVALID_RECORD',
  'CORRUPT_MESSAGE',
  'INVALID_TOPIC_EXCEPTION',
  'UNSUPPORTED_FOR_MESSAGE_FORMAT',
]);

/**
 * Splits publish failures into "try again later" (timeouts, connection resets, leader changes, anything unknown:
 * bounded by the attempt limit) and "park now" (the broker rejects this very message).
 */
export function classifyPublishError(error: unknown): PublishErrorClass {
  let current: unknown = error;
  // kafkajs wraps the last failure in a retries-exceeded error; classify the cause.
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const { type, cause } = current as { type?: unknown; cause?: unknown };
    if (typeof type === 'string' && NON_RETRYABLE_PROTOCOL_TYPES.has(type))
      return 'non-retryable';
    if (cause === undefined) break;
    current = cause;
  }
  return 'retryable';
}
