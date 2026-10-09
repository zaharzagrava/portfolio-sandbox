import { KafkaContext } from '@nestjs/microservices';
import { KafkaConsumerService } from './kafka-consumer.service';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';

const contextOf = (key: string | null, traceparent?: string): KafkaContext =>
  ({
    getTopic: () => 'payments.requests',
    getMessage: () => ({
      key: key === null ? null : Buffer.from(key),
      headers: traceparent ? { traceparent: Buffer.from(traceparent) } : {},
    }),
  }) as unknown as KafkaContext;

describe('KafkaConsumerService (deprecated request/response path)', () => {
  const service = new KafkaConsumerService();

  it('S53 G-27: the message key is the idempotency key and the handler result is returned', async () => {
    const handler = jest.fn().mockResolvedValue('done');
    const result = await service.consume({
      spanName: 'spec',
      data: { n: 1 },
      context: contextOf('key-1'),
      responseTopic: 'payments.responses',
      handler,
    });
    expect(result).toBe('done');
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'key-1',
        responseTopic: 'payments.responses',
      }),
    );
  });

  it('S53 G-27: a failing handler propagates the error (no outbox dead-letter row is written any more)', async () => {
    await expect(
      service.consume({
        spanName: 'spec',
        data: {},
        context: contextOf('key-2'),
        responseTopic: 'payments.responses',
        handler: async () => {
          throw new Error('handler failed');
        },
      }),
    ).rejects.toThrow('handler failed');
  });

  it('S53 G-27: a message without a key has an empty idempotency key', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    await service.consume({
      spanName: 'spec',
      data: {},
      context: contextOf(null, `00-${TRACE_ID}-b7ad6b7169203331-01`),
      responseTopic: 'r',
      handler,
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: '' }),
    );
  });
});
