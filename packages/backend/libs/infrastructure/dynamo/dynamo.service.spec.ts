import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import type { ApiConfigService } from '@app/common/config';
import { DynamoService } from './dynamo.service';

const config = {
  get: (key: string) =>
    ({ dynamo_endpoint: 'http://localhost:1', dynamo_table_prefix: 't_' })[key],
} as unknown as ApiConfigService;

const unsupported = () =>
  Object.assign(new Error('Unsupported operation TransactWriteItems'), {
    name: 'UnknownOperationException',
  });

const items = [
  { Put: { TableName: 'T', Item: { PK: 'a' } } },
  {
    Update: {
      TableName: 'T',
      Key: { PK: 'b' },
      UpdateExpression: 'SET x = :x',
    },
  },
  { Delete: { TableName: 'T', Key: { PK: 'c' } } },
];

describe('DynamoService.transactWrite', () => {
  const build = (send: jest.Mock) => {
    const service = new DynamoService(config);
    (service.doc as unknown as { send: jest.Mock }).send = send;
    return service;
  };
  const commandNames = (send: jest.Mock) =>
    send.mock.calls.map(([command]) => command.constructor.name);

  it('uses one transaction where the endpoint supports it', async () => {
    const send = jest.fn().mockResolvedValue({});
    await build(send).transactWrite(items);
    expect(commandNames(send)).toEqual(['TransactWriteCommand']);
  });

  it('on an endpoint without transactions it runs the items in order, updates first, and remembers', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(unsupported())
      .mockResolvedValue({});
    const service = build(send);
    await service.transactWrite(items);
    expect(commandNames(send)).toEqual([
      'TransactWriteCommand',
      'UpdateCommand',
      'PutCommand',
      'DeleteCommand',
    ]);

    send.mockClear();
    await service.transactWrite(items);
    expect(commandNames(send)).toEqual([
      'UpdateCommand',
      'PutCommand',
      'DeleteCommand',
    ]);
  });

  it('turns a failed condition of the sequential path into a cancelled transaction and stops', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(unsupported())
      .mockRejectedValueOnce(
        new ConditionalCheckFailedException({
          message: 'condition',
          $metadata: {},
        }),
      );
    await expect(build(send).transactWrite(items)).rejects.toBeInstanceOf(
      TransactionCanceledException,
    );
    expect(commandNames(send)).toEqual([
      'TransactWriteCommand',
      'UpdateCommand',
    ]);
  });

  it('passes other errors of the real transaction through', async () => {
    const send = jest
      .fn()
      .mockRejectedValue(
        new TransactionCanceledException({ message: 'x', $metadata: {} }),
      );
    await expect(build(send).transactWrite(items)).rejects.toBeInstanceOf(
      TransactionCanceledException,
    );
    expect(commandNames(send)).toEqual(['TransactWriteCommand']);
  });
});
