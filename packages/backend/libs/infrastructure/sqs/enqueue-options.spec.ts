import {
  InvalidEnqueueOptionsError,
  validateEnqueueOptions,
} from './enqueue-options';
import { SqsTaskQueue } from './sqs-task-queue';
import { InMemoryTaskQueue } from './in-memory-task-queue';

const STD = 'jobs';
const FIFO = 'jobs.fifo';

describe('S53 task queue enqueue options', () => {
  it.each([
    ['no options', STD, {}],
    ['zero delay', STD, { delaySeconds: 0 }],
    ['a delay', STD, { delaySeconds: 2 }],
    ['the maximum delay', STD, { delaySeconds: 900 }],
    ['a FIFO group', FIFO, { groupId: 'g1' }],
    ['a FIFO group with a dedupe id', FIFO, { groupId: 'g1', dedupeId: 'd1' }],
    ['attributes', STD, { attributes: { a: 'b' } }],
  ])('S53 AS-92: %s is accepted', (_label, queue, options) => {
    expect(() => validateEnqueueOptions(queue, options)).not.toThrow();
  });

  it.each([
    ['a negative delay', STD, { delaySeconds: -1 }, /delaySeconds/],
    ['a fractional delay', STD, { delaySeconds: 1.5 }, /delaySeconds/],
    ['a delay of 901 seconds', STD, { delaySeconds: 901 }, /delaySeconds/],
    ['a NaN delay', STD, { delaySeconds: Number.NaN }, /delaySeconds/],
    [
      'an infinite delay',
      STD,
      { delaySeconds: Number.POSITIVE_INFINITY },
      /delaySeconds/,
    ],
    [
      'a delay together with a FIFO group',
      FIFO,
      { delaySeconds: 5, groupId: 'g1' },
      /FIFO/,
    ],
    ['a group on a standard queue', STD, { groupId: 'g1' }, /groupId/],
    ['a dedupe id on a standard queue', STD, { dedupeId: 'd1' }, /dedupeId/],
    ['a FIFO queue without a group', FIFO, {}, /groupId/],
    ['an empty group id', FIFO, { groupId: '' }, /groupId/],
    ['an empty dedupe id', FIFO, { groupId: 'g', dedupeId: '' }, /dedupeId/],
  ])(
    'S53 AS-92: %s is rejected with InvalidEnqueueOptionsError',
    (_label, queue, options, message) => {
      expect(() => validateEnqueueOptions(queue, options)).toThrow(
        InvalidEnqueueOptionsError,
      );
      expect(() => validateEnqueueOptions(queue, options)).toThrow(message);
    },
  );

  it('S53 AS-92: every problem is named in one error', () => {
    try {
      validateEnqueueOptions(FIFO, {
        delaySeconds: -5,
        groupId: 'g',
        dedupeId: '',
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidEnqueueOptionsError);
      expect(
        (e as InvalidEnqueueOptionsError).problems.length,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it.each([
    [
      'the SQS adapter',
      () =>
        new SqsTaskQueue({
          get: (k: string) =>
            k === 'sqs_endpoint' ? 'http://127.0.0.1:1' : undefined,
        } as never),
    ],
    ['the in-memory fake', () => new InMemoryTaskQueue()],
  ])(
    'S53 AS-92: %s rejects invalid options before any network call',
    async (_label, make) => {
      const queue = make();
      await expect(
        queue.enqueue(STD, { a: 1 }, { delaySeconds: 901 }),
      ).rejects.toBeInstanceOf(InvalidEnqueueOptionsError);
      await expect(
        queue.enqueue(FIFO, { a: 1 }, { groupId: 'g', delaySeconds: 3 }),
      ).rejects.toBeInstanceOf(InvalidEnqueueOptionsError);
      await expect(
        queue.enqueueBatch(STD, [
          { body: 1 },
          { body: 2, options: { delaySeconds: -1 } },
        ]),
      ).rejects.toBeInstanceOf(InvalidEnqueueOptionsError);
    },
  );
});
