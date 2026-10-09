import { z } from 'zod';
import {
  HandlerTimeoutError,
  PermanentError,
  SinkBackpressureError,
  TransientError,
} from './errors';
import { classifyConsumerError } from './consumer-error-classification';

const withCode = (code: string, message = code) =>
  Object.assign(new Error(message), { code });
const named = (name: string) => Object.assign(new Error(name), { name });
const wrapped = (cause: unknown) =>
  Object.assign(new Error('wrapper'), { cause });
const zodError = (() => {
  const r = z.object({ a: z.string() }).safeParse({});
  return r.success ? new Error('never') : r.error;
})();

describe('S53 consumer error classification', () => {
  it.each([
    ['TransientError', new TransientError('store down'), 'transient'],
    [
      'SinkBackpressureError',
      new SinkBackpressureError('saturated', 2_000),
      'transient',
    ],
    ['HandlerTimeoutError', new HandlerTimeoutError(30_000), 'transient'],
    ['PermanentError', new PermanentError('bad data'), 'permanent'],
    ['a plain Error (unclassified)', new Error('boom'), 'permanent'],
    ['a thrown string (unclassified)', 'boom', 'permanent'],
    ['a thrown undefined', undefined, 'permanent'],
    ['a schema failure', zodError, 'permanent'],
    ['ECONNRESET', withCode('ECONNRESET'), 'transient'],
    ['ECONNREFUSED', withCode('ECONNREFUSED'), 'transient'],
    ['ETIMEDOUT', withCode('ETIMEDOUT'), 'transient'],
    ['EPIPE', withCode('EPIPE'), 'transient'],
    ['ENOTFOUND', withCode('ENOTFOUND'), 'transient'],
    ['Postgres serialization failure 40001', withCode('40001'), 'transient'],
    ['Postgres deadlock 40P01', withCode('40P01'), 'transient'],
    ['Postgres too many connections 53300', withCode('53300'), 'transient'],
    [
      'Postgres unique violation 23505 (a data problem)',
      withCode('23505'),
      'permanent',
    ],
    [
      'Sequelize connection error',
      named('SequelizeConnectionError'),
      'transient',
    ],
    [
      'Sequelize connection refused',
      named('SequelizeConnectionRefusedError'),
      'transient',
    ],
    [
      'Sequelize pool acquire timeout',
      named('SequelizeConnectionAcquireTimeoutError'),
      'transient',
    ],
    [
      'Sequelize validation error (a data problem)',
      named('SequelizeValidationError'),
      'permanent',
    ],
    [
      'ioredis closed connection',
      new Error('Connection is closed.'),
      'transient',
    ],
    ['AWS throttling', named('ThrottlingException'), 'transient'],
    [
      'AWS provisioned throughput exceeded',
      named('ProvisionedThroughputExceededException'),
      'transient',
    ],
    ['AWS request timeout', named('TimeoutError'), 'transient'],
    [
      'an Elasticsearch 429 response',
      Object.assign(new Error('too many requests'), { statusCode: 429 }),
      'transient',
    ],
    [
      'an Elasticsearch 503 response',
      Object.assign(new Error('unavailable'), { statusCode: 503 }),
      'transient',
    ],
    [
      'an Elasticsearch 400 response',
      Object.assign(new Error('bad request'), { statusCode: 400 }),
      'permanent',
    ],
    [
      'a transient error wrapped in a plain error',
      wrapped(new TransientError('x')),
      'transient',
    ],
    [
      'a connection error three levels down',
      wrapped(wrapped(withCode('ECONNRESET'))),
      'transient',
    ],
    [
      'a permanent error wrapped in a plain error',
      wrapped(new PermanentError('x')),
      'permanent',
    ],
  ])('S53 AS-59: %s is %s', (_label, error, expected) => {
    expect(classifyConsumerError(error).class).toBe(expected);
  });

  it('S53 AS-60: a backpressure error carries its own retry delay, other transient errors have none', () => {
    expect(
      classifyConsumerError(new SinkBackpressureError('x', 2_000)),
    ).toEqual({
      class: 'transient',
      retryAfterMs: 2_000,
    });
    expect(classifyConsumerError(new TransientError('x'))).toEqual({
      class: 'transient',
    });
  });

  it('S53 AS-59: an explicit PermanentError wins over a transient cause', () => {
    const error = Object.assign(new PermanentError('data is wrong'), {
      cause: withCode('ECONNRESET'),
    });
    expect(classifyConsumerError(error).class).toBe('permanent');
  });
});
