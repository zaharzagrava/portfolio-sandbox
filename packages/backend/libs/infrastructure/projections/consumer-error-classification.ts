import {
  PermanentError,
  SinkBackpressureError,
  TransientError,
} from './errors';

export interface ErrorClassification {
  class: 'transient' | 'permanent';
  /** Set when the failing store said how long to wait (`SinkBackpressureError`). */
  retryAfterMs?: number;
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  // Postgres: serialization failure, deadlock, admin shutdown, too many connections, out of memory
  '40001',
  '40P01',
  '57P01',
  '53300',
  '53200',
]);

const TRANSIENT_NAMES = new Set([
  'SequelizeConnectionError',
  'SequelizeConnectionRefusedError',
  'SequelizeConnectionTimedOutError',
  'SequelizeConnectionAcquireTimeoutError',
  'SequelizeHostNotFoundError',
  'SequelizeHostNotReachableError',
  'ThrottlingException',
  'ThrottledException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
  'TooManyRequestsException',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'TimeoutError',
  'MaxRetriesPerRequestError',
  'KafkaJSConnectionError',
  'KafkaJSRequestTimeoutError',
]);

const TRANSIENT_MESSAGE =
  /connection is closed|connection (terminated|reset|lost)|socket hang up|timed? ?out/i;

const MAX_DEPTH = 5;

const statusOf = (error: object): number | undefined => {
  const candidate =
    (error as { statusCode?: unknown }).statusCode ??
    (error as { status?: unknown }).status;
  return typeof candidate === 'number' ? candidate : undefined;
};

/**
 * Splits handler failures into "the store is unwell, wait" and "this event is the problem" (S53 FR-035). Explicit
 * classes win: `PermanentError` is permanent even over a transient cause. Otherwise network and store codes,
 * driver names and server statuses decide, walking `cause`. Anything unrecognised is permanent: a bug must reach
 * the dead-letter topic rather than loop forever.
 */
export function classifyConsumerError(error: unknown): ErrorClassification {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < MAX_DEPTH && current !== undefined && current !== null;
    depth++
  ) {
    if (current instanceof PermanentError) return { class: 'permanent' };
    if (current instanceof SinkBackpressureError)
      return { class: 'transient', retryAfterMs: current.retryAfterMs };
    if (current instanceof TransientError) return { class: 'transient' };
    if (typeof current === 'object') {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && TRANSIENT_CODES.has(code))
        return { class: 'transient' };
      if (typeof code === 'string' && /^08/.test(code))
        return { class: 'transient' }; // Postgres connection exception class
      const name = (current as { name?: unknown }).name;
      if (typeof name === 'string' && TRANSIENT_NAMES.has(name))
        return { class: 'transient' };
      const status = statusOf(current);
      if (
        status !== undefined &&
        (status === 408 ||
          status === 425 ||
          status === 429 ||
          (status >= 500 && status !== 501))
      )
        return { class: 'transient' };
      const message = (current as { message?: unknown }).message;
      if (
        current instanceof Error &&
        typeof message === 'string' &&
        TRANSIENT_MESSAGE.test(message)
      )
        return { class: 'transient' };
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return { class: 'permanent' };
}
