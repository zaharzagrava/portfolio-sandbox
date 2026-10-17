import type { SqsEvent, SqsRecord } from '@app/infrastructure/serverless';

/**
 * The Lambda entry point of delivery (S43 AS-45): the handler answers with the partial-batch response, listing exactly
 * the records the delivery host asked to see again, and in a FIFO batch also the later records of a failed record's
 * group, which it did not run (their order is kept). The host itself (what a record does to the delivery, the receiver and
 * the log) is proven against real stores in `webhook-delivery.e2e-spec.ts` of the domain; here the host is a stand-in.
 */
const handleRecord = jest.fn<Promise<string>, [string, number]>();

jest.mock('@app/domains/developer-platform', () => ({
  WebhooksLambdaModule: { host: () => ({ handleRecord }) },
}));
jest.mock('@app/infrastructure/serverless/context', () => ({
  nestContext: () => Promise.resolve({}),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require('./webhook-delivery') as {
  handler: (
    event: SqsEvent,
  ) => Promise<{ batchItemFailures: { itemIdentifier: string }[] }>;
};

const ARN = 'arn:aws:sqs:eu-central-1:000000000000:webhook-deliveries.fifo';
const record = (id: string, group: string, receives = 1): SqsRecord => ({
  messageId: id,
  receiptHandle: `r-${id}`,
  body: JSON.stringify({ endpointId: group, id }),
  attributes: {
    ApproximateReceiveCount: String(receives),
    MessageGroupId: group,
  },
  eventSourceARN: ARN,
});

describe('Webhook delivery Lambda handler', () => {
  beforeEach(() => handleRecord.mockReset());

  it('S43 AS-45: a batch of three messages for three endpoints where the second is to be redelivered reports only that one failed', async () => {
    handleRecord.mockImplementation((body) =>
      JSON.parse(body).id === 'm2'
        ? Promise.reject(new Error('redeliver'))
        : Promise.resolve('delivered'),
    );

    const response = await handler({
      Records: [record('m1', 'e1'), record('m2', 'e2'), record('m3', 'e3')],
    });

    expect(response).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }] });
    expect(handleRecord).toHaveBeenCalledTimes(3);
    expect(handleRecord.mock.calls.map(([, receives]) => receives)).toEqual([
      1, 1, 1,
    ]);
  });

  it('S43 AS-45: the receive count of the record reaches the host, and a later record of the failed record’s group is reported failed without running', async () => {
    handleRecord.mockImplementation((body) =>
      JSON.parse(body).id === 'a1'
        ? Promise.reject(new Error('redeliver'))
        : Promise.resolve('delivered'),
    );

    const response = await handler({
      Records: [
        record('a1', 'e1', 3),
        record('a2', 'e1', 1), // same endpoint: must wait behind a1
        record('b1', 'e2', 1), // another endpoint: unaffected
      ],
    });

    expect(response.batchItemFailures.map((f) => f.itemIdentifier)).toEqual([
      'a1',
      'a2',
    ]);
    expect(handleRecord).toHaveBeenCalledTimes(2);
    expect(handleRecord.mock.calls[0][1]).toBe(3);
  });
});
