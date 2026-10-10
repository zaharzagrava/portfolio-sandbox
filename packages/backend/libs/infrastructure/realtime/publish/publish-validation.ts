import {
  InvalidRealtimeEventTypeError,
  InvalidRealtimePayloadError,
  InvalidRealtimeTopicError,
  RealtimePayloadTooLargeError,
} from '../errors';
import { EVENT_TYPE, RESERVED_EVENT_TYPES } from '../frame';
import { parseTopicShape } from '../topics';

/**
 * Everything `publish` checks before it touches the store (S51 FR-021). Returns the serialized payload so the size that
 * was measured is the size that is stored. Pure.
 */
export function validatePublish(
  topic: string,
  type: string,
  data: unknown,
  maxPayloadBytes: number,
): string {
  if (typeof topic !== 'string' || !parseTopicShape(topic))
    throw new InvalidRealtimeTopicError(String(topic));
  if (
    typeof type !== 'string' ||
    !EVENT_TYPE.test(type) ||
    RESERVED_EVENT_TYPES.includes(type)
  )
    throw new InvalidRealtimeEventTypeError(String(type));
  if (data === undefined) throw new InvalidRealtimePayloadError('undefined');
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data);
  } catch (error) {
    throw new InvalidRealtimePayloadError((error as Error).message);
  }
  if (serialized === undefined)
    throw new InvalidRealtimePayloadError('not serializable');
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maxPayloadBytes)
    throw new RealtimePayloadTooLargeError(bytes, maxPayloadBytes);
  return serialized;
}
