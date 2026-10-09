import { z } from 'zod';
import { defineEvent } from './define-event';
import {
  DuplicateAggregateTypeError,
  InvalidAggregateTypeError,
  InvalidPartitionCountError,
  TopicPolicyError,
  UnregisteredAggregateTypeError,
} from './topic-errors';
import { TopicRegistry } from './topic-registry';

const schema = z.object({ a: z.string() });
const newRegistry = () =>
  new TopicRegistry({ defaultPartitions: 12, hotPartitions: 64 });

describe('S53 topic registry and policy', () => {
  it('S53 AS-12: latest-per-key with a delta event is rejected, naming the event type', () => {
    defineEvent('tpolicya.changed', 'tpolicya', 1, schema, {
      carries: 'delta',
    });
    defineEvent('tpolicya.snapshot', 'tpolicya', 1, schema, {
      carries: 'state',
    });
    expect(() =>
      newRegistry().register({
        aggregateType: 'tpolicya',
        retention: 'latest-per-key',
      }),
    ).toThrow(TopicPolicyError);
    expect(() =>
      newRegistry().register({
        aggregateType: 'tpolicya',
        retention: 'latest-per-key',
      }),
    ).toThrow(/tpolicya\.changed/);
  });

  it('S53 AS-12: latest-per-key with only state events is accepted and compacts', () => {
    defineEvent('tpolicyb.snapshot', 'tpolicyb', 1, schema, {
      carries: 'state',
    });
    const registry = newRegistry();
    registry.register({
      aggregateType: 'tpolicyb',
      retention: 'latest-per-key',
    });
    expect(registry.get('tpolicyb')).toMatchObject({
      topic: 'tpolicyb.events',
      retention: 'latest-per-key',
      configEntries: expect.arrayContaining([
        { name: 'cleanup.policy', value: 'compact' },
      ]),
    });
  });

  it('S53 AS-12: full-history accepts delta events and never deletes by age', () => {
    defineEvent('tpolicyc.changed', 'tpolicyc', 1, schema, {
      carries: 'delta',
    });
    const registry = newRegistry();
    registry.register({ aggregateType: 'tpolicyc', retention: 'full-history' });
    expect(registry.get('tpolicyc').configEntries).toEqual(
      expect.arrayContaining([
        { name: 'cleanup.policy', value: 'delete' },
        { name: 'retention.ms', value: '-1' },
      ]),
    );
  });

  it('S53 AS-12: a delta event defined after a latest-per-key registration fails at validate()', () => {
    const registry = newRegistry();
    registry.register({
      aggregateType: 'tpolicyd',
      retention: 'latest-per-key',
    });
    defineEvent('tpolicyd.changed', 'tpolicyd', 1, schema, {
      carries: 'delta',
    });
    expect(() => registry.validate()).toThrow(/tpolicyd\.changed/);
  });

  it('S53 AS-11: registering the same aggregate type twice rejects', () => {
    const registry = newRegistry();
    registry.register({ aggregateType: 'tdup', retention: 'full-history' });
    expect(() =>
      registry.register({ aggregateType: 'tdup', retention: 'full-history' }),
    ).toThrow(DuplicateAggregateTypeError);
  });

  it.each([
    ['empty', ''],
    ['upper case', 'Orders'],
    ['contains a dot', 'orders.events'],
    ['contains a space', 'my orders'],
    ['starts with a digit', '1orders'],
  ])(
    'S53 AS-11: an aggregate type that is %s rejects',
    (_label, aggregateType) => {
      expect(() =>
        newRegistry().register({ aggregateType, retention: 'full-history' }),
      ).toThrow(InvalidAggregateTypeError);
    },
  );

  it('S53 AS-11: an unregistered aggregate type has no topic', () => {
    expect(() => newRegistry().topicFor('ghost')).toThrow(
      UnregisteredAggregateTypeError,
    );
  });

  it('S53 AS-11: a registered type maps to <aggregateType>.events', () => {
    const registry = newRegistry();
    registry.register({ aggregateType: 'tmapped', retention: 'full-history' });
    expect(registry.topicFor('tmapped')).toBe('tmapped.events');
  });

  it.each([
    ['default', {}, 12],
    ['hot', { hot: true }, 64],
    ['explicit', { partitions: 3 }, 3],
    ['explicit beats hot', { partitions: 3, hot: true }, 3],
  ])('S53 AS-11: partition count (%s)', (_label, options, expected) => {
    const registry = newRegistry();
    registry.register({
      aggregateType: `tpart${expected}${JSON.stringify(options).length}`,
      retention: 'full-history',
      ...options,
    });
    expect(
      registry.get(`tpart${expected}${JSON.stringify(options).length}`)
        .partitions,
    ).toBe(expected);
  });

  it.each([0, -2, 1.5])(
    'S53 AS-11: partition count %s rejects',
    (partitions) => {
      expect(() =>
        newRegistry().register({
          aggregateType: 'tbadpart',
          retention: 'full-history',
          partitions,
        }),
      ).toThrow(InvalidPartitionCountError);
    },
  );
});
