import {
  KafkaJSConnectionError,
  KafkaJSNonRetriableError,
  KafkaJSNumberOfRetriesExceeded,
  KafkaJSProtocolError,
  KafkaJSRequestTimeoutError,
} from 'kafkajs';
import { PublishTimeoutError } from '@app/infrastructure/events/event-errors';
import { classifyPublishError } from './error-classification';

const protocol = (type: string, retriable: boolean) =>
  new KafkaJSProtocolError(
    Object.assign(new Error(type), { type, code: 1, retriable }),
  );

describe('S53 relay publish error classification', () => {
  it.each([
    [
      'message too large',
      protocol('MESSAGE_TOO_LARGE', false),
      'non-retryable',
    ],
    ['invalid message', protocol('INVALID_MESSAGE', false), 'non-retryable'],
    ['invalid record', protocol('INVALID_RECORD', false), 'non-retryable'],
    ['corrupt message', protocol('CORRUPT_MESSAGE', false), 'non-retryable'],
    [
      'record list too large',
      protocol('RECORD_LIST_TOO_LARGE', false),
      'non-retryable',
    ],
    [
      'invalid topic',
      protocol('INVALID_TOPIC_EXCEPTION', false),
      'non-retryable',
    ],
    [
      'leader not available',
      protocol('LEADER_NOT_AVAILABLE', true),
      'retryable',
    ],
    [
      'not leader for partition',
      protocol('NOT_LEADER_FOR_PARTITION', true),
      'retryable',
    ],
    [
      'request timed out (protocol)',
      protocol('REQUEST_TIMED_OUT', true),
      'retryable',
    ],
    ['connection error', new KafkaJSConnectionError('ECONNRESET'), 'retryable'],
    [
      'request timeout',
      new KafkaJSRequestTimeoutError('timeout', {
        broker: 'b',
        clientId: 'c',
        correlationId: 1,
        createdAt: 0,
        sentAt: 0,
        pendingDuration: 0,
      }),
      'retryable',
    ],
    [
      'our own publish timeout',
      new PublishTimeoutError('t', 10_000),
      'retryable',
    ],
    [
      'plain socket error',
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      'retryable',
    ],
    ['unknown error', new Error('boom'), 'retryable'],
    ['non-error throw', 'boom', 'retryable'],
    [
      'kafkajs non retriable (unknown cause)',
      new KafkaJSNonRetriableError('x'),
      'retryable',
    ],
  ])('S53 AS-19: %s is %s', (_label, error, expected) => {
    expect(classifyPublishError(error)).toBe(expected);
  });

  it('S53 AS-19: retries-exceeded wrapper is classified by its cause', () => {
    const tooLarge = new KafkaJSNumberOfRetriesExceeded(
      protocol('MESSAGE_TOO_LARGE', false),
      { retryCount: 5, retryTime: 100 },
    );
    expect(classifyPublishError(tooLarge)).toBe('non-retryable');
    const down = new KafkaJSNumberOfRetriesExceeded(
      new KafkaJSConnectionError('ECONNREFUSED'),
      { retryCount: 5, retryTime: 100 },
    );
    expect(classifyPublishError(down)).toBe('retryable');
  });
});
