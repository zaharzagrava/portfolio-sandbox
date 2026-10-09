import { processBatch, SqsEvent } from './sqs-batch';

const record = (id: string, group?: string, fifo = false) => ({
  messageId: id,
  receiptHandle: `rh-${id}`,
  body: id,
  attributes: {
    ApproximateReceiveCount: '1',
    ...(group && { MessageGroupId: group }),
  },
  eventSourceARN: `arn:aws:sqs:eu-central-1:1:q${fifo ? '.fifo' : ''}`,
});

/** Every Lambda handler reports failures through this - pure → unit spec. */
describe('processBatch', () => {
  it('standard queue: only the failed records are reported', async () => {
    const event: SqsEvent = {
      Records: ['a', 'b', 'c'].map((id) => record(id)),
    };
    const res = await processBatch(event, async (r) => {
      if (r.body === 'b') throw new Error('boom');
    });
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'b' }]);
  });

  it('FIFO: after a failure, later records of the SAME group are failed without running; other groups proceed', async () => {
    const event: SqsEvent = {
      Records: [
        record('a1', 'A', true),
        record('a2', 'A', true),
        record('b1', 'B', true),
        record('a3', 'A', true),
      ],
    };
    const ran: string[] = [];
    const res = await processBatch(event, async (r) => {
      ran.push(r.body);
      if (r.body === 'a2') throw new Error('boom');
    });
    expect(ran).toEqual(['a1', 'a2', 'b1']);
    expect(res.batchItemFailures.map((f) => f.itemIdentifier)).toEqual([
      'a2',
      'a3',
    ]);
  });
});
