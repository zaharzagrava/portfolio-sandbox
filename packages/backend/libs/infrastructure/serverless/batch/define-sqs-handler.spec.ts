import { z } from 'zod';
import { defineSqsHandler, type FunctionInfo } from './define-sqs-handler';
import { PermanentError, TransientError } from '../errors';
import { captureTelemetry, sqsRecord, type Capture } from '../testing';

const fn: FunctionInfo = {
  name: 'fixture',
  queue: 'fixture-queue',
  fifo: false,
  maxReceiveCount: 5,
};
const fifoFn: FunctionInfo = {
  ...fn,
  queue: 'fixture-queue.fifo',
  fifo: true,
};
const schema = z.object({ documentId: z.string().uuid() });
const ID = '8f0c1f0e-0b0a-4d5e-9a41-1c7b6a9d2e11';

describe('defineSqsHandler', () => {
  let capture: Capture;
  beforeEach(() => (capture = captureTelemetry()));
  afterEach(() => capture.restore());

  it.each([
    ['not JSON', 'access_token=abc123 mail=jane@example.com'],
    ['schema failure', JSON.stringify({ documentId: 'jane@example.com' })],
  ])(
    'S55 AS-06: a body that is %s never reaches the handler, is a permanent failure and is not logged',
    async (_name, body) => {
      const handle = jest.fn();
      const handler = defineSqsHandler({
        function: fn,
        bodySchema: schema,
        handle,
      });
      const res = await handler({
        Records: [
          sqsRecord('bad', { body }),
          sqsRecord('good', { body: JSON.stringify({ documentId: ID }) }),
        ],
      });
      expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }]);
      expect(handle).toHaveBeenCalledTimes(1);
      expect(handle.mock.calls[0][0]).toMatchObject({
        id: 'good',
        body: { documentId: ID },
        receiveCount: 1,
      });
      expect(capture.metrics('RecordsFailed')[0]).toMatchObject({
        outcome: 'permanent',
      });
      const failure = capture.logs('record failed')[0];
      expect(failure).toMatchObject({
        messageId: 'bad',
        errorClass: 'InvalidBodyError',
        failureClass: 'permanent',
      });
      expect(capture.lines.join('')).not.toContain('abc123');
      expect(capture.lines.join('')).not.toContain('jane@example.com');
    },
  );

  it.each([
    ['standard', fn, 4, false, false],
    ['standard', fn, 5, true, false],
    ['FIFO', fifoFn, 4, false, false],
    ['FIFO', fifoFn, 5, true, true],
  ])(
    'S55 AS-10: %s queue, failure at receive %i: dead-lettered signal %s, group order broken %s',
    async (_name, info, receiveCount, deadLettered, broken) => {
      const handler = defineSqsHandler({
        function: info,
        handle: async () => {
          throw new TransientError('provider down');
        },
      });
      await handler({
        Records: [
          sqsRecord('m', { receiveCount, group: 'G', fifo: info.fifo }),
        ],
      });
      expect(capture.metrics('DeadLettered')).toHaveLength(
        deadLettered ? 1 : 0,
      );
      expect(capture.metrics('FifoGroupOrderBroken')).toHaveLength(
        broken ? 1 : 0,
      );
      if (deadLettered) {
        expect(capture.metrics('DeadLettered')[0]).toMatchObject({
          function: 'fixture',
          queue: info.queue,
          DeadLettered: 1,
        });
        expect(capture.logs('record will be dead-lettered')[0]).toMatchObject({
          level: 'error',
          messageId: 'm',
        });
      }
    },
  );

  it('S55 AS-11: failure logs carry identifiers and the error, never the body or attribute values', async () => {
    const handler = defineSqsHandler({
      function: fn,
      handle: async () => {
        throw new PermanentError('cannot apply');
      },
    });
    await handler({
      Records: [
        sqsRecord('m1', {
          receiveCount: 3,
          body: JSON.stringify({ token: 'tok_SECRET', email: 'c@example.com' }),
          attributes: { tenant: 'attr-SECRET' },
        }),
      ],
    });
    const line = capture.logs('record failed')[0];
    expect(line).toMatchObject({
      messageId: 'm1',
      function: 'fixture',
      queue: 'fixture-queue',
      receiveCount: 3,
      errorClass: 'PermanentError',
      error: 'cannot apply',
    });
    const all = capture.lines.join('');
    for (const secret of ['tok_SECRET', 'c@example.com', 'attr-SECRET'])
      expect(all).not.toContain(secret);
  });

  it('S55 AS-35: a dead-letter handler may acknowledge an unreadable body instead of looping on it', async () => {
    const seen = jest.fn();
    const handle = jest.fn();
    const handler = defineSqsHandler({
      function: fn,
      bodySchema: schema,
      handle,
      onInvalidBody: seen,
    });
    const res = await handler({ Records: [sqsRecord('junk', { body: '{{' })] });
    expect(res.batchItemFailures).toEqual([]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(handle).not.toHaveBeenCalled();
  });

  it('S55 AS-12: an init that rejects fails the invocation as a whole and no record handler runs', async () => {
    const handle = jest.fn();
    const handler = defineSqsHandler({
      function: fn,
      init: async () => {
        throw new Error('context cannot initialise');
      },
      handle,
    });
    await expect(
      handler({ Records: ['a', 'b', 'c'].map((id) => sqsRecord(id)) }),
    ).rejects.toThrow('context cannot initialise');
    expect(handle).not.toHaveBeenCalled();
  });
});
