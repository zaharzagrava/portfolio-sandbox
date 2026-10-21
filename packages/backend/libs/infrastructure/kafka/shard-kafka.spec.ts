import type { Kafka } from 'kafkajs';
import { shardName, unshardName } from '@app/common/shard';
import { shardKafka } from './shard-kafka';

describe('test sharding of names (TEST_SHARD)', () => {
  const before = process.env.TEST_SHARD;
  afterEach(() => {
    if (before === undefined) delete process.env.TEST_SHARD;
    else process.env.TEST_SHARD = before;
  });

  it('leaves every name and the Kafka client untouched without a shard', () => {
    delete process.env.TEST_SHARD;
    const kafka = {} as Kafka;
    expect(shardName('products')).toBe('products');
    expect(unshardName('products')).toBe('products');
    expect(shardKafka(kafka)).toBe(kafka);
  });

  it('puts the shard in front of names and takes it off again; refuses a bad id', () => {
    process.env.TEST_SHARD = '2';
    expect(shardName('products')).toBe('s2-products');
    expect(unshardName('s2-products')).toBe('products');
    expect(unshardName('s1-products')).toBeUndefined();
    process.env.TEST_SHARD = 'a b';
    expect(() => shardName('x')).toThrow('TEST_SHARD');
  });

  it('prefixes topics and groups going to the broker and strips them from what comes back', async () => {
    process.env.TEST_SHARD = '1';
    const sent: unknown[] = [];
    const subscribed: unknown[] = [];
    let groupId = '';
    const kafka = {
      producer: () => ({ send: async (r: unknown) => void sent.push(r) }),
      consumer: (c: { groupId: string }) => {
        groupId = c.groupId;
        return {
          subscribe: async (a: unknown) => void subscribed.push(a),
          run: async (cfg: { eachMessage: (p: unknown) => Promise<void> }) =>
            cfg.eachMessage({ topic: 's1-orders.events', partition: 0 }),
        };
      },
      admin: () => ({
        listTopics: async () => ['s1-orders.events', 's2-orders.events', 'x'],
        describeGroups: async (ids: string[]) => ({
          groups: ids.map((groupId) => ({ groupId })),
        }),
      }),
    } as unknown as Kafka;
    const wrapped = shardKafka(kafka);

    await wrapped.producer().send({ topic: 'orders.events', messages: [] });
    expect(sent).toEqual([{ topic: 's1-orders.events', messages: [] }]);

    const consumer = wrapped.consumer({ groupId: 'billing' });
    expect(groupId).toBe('s1-billing');
    await consumer.subscribe({ topic: 'orders.events' });
    await consumer.subscribe({ topic: /^orders\./ });
    expect(subscribed[0]).toEqual({ topic: 's1-orders.events' });
    expect((subscribed[1] as { topic: RegExp }).topic.test('s1-orders.x')).toBe(
      true,
    );
    expect((subscribed[1] as { topic: RegExp }).topic.test('s2-orders.x')).toBe(
      false,
    );
    const seen: unknown[] = [];
    await consumer.run({ eachMessage: async (p) => void seen.push(p.topic) });
    expect(seen).toEqual(['orders.events']);

    const admin = wrapped.admin();
    expect(await admin.listTopics()).toEqual(['orders.events']);
    expect((await admin.describeGroups(['billing'])).groups[0].groupId).toBe(
      'billing',
    );
  });
});
