import type { RealtimePublisher } from './publish/realtime-publisher.service';
import { topicOf, type RealtimeTopic } from './topics';

declare module './topics' {
  interface RealtimeTopicPrefixes {
    'type-test': `type-test:${string}`;
    'type-test-shop:live': `type-test-shop:${string}:live`;
  }
}

const publisher = null as unknown as RealtimePublisher;

/** S51 AS-34: topics are checked at compile time. The `@ts-expect-error` lines fail `tsc` if they ever compile. */
describe('S51 AS-34 compile-time topic types', () => {
  it('accepts declared routes and rejects everything else at compile time', () => {
    const declared: RealtimeTopic = 'type-test:abc';
    const suffixed: RealtimeTopic = 'type-test-shop:s1:live';
    const calls = () => {
      void publisher.publish(declared, 'price', {});
      void publisher.publish(suffixed, 'price', {});
      void publisher.publish(topicOf('type-test', 'x'), 'price', {});
      // @ts-expect-error a prefix no domain declared
      void publisher.publish('nosuch:abc', 'price', {});
      // @ts-expect-error not the <prefix>:<id> shape
      void publisher.publish('justastring', 'price', {});
      // @ts-expect-error a suffix the route does not declare
      void publisher.publish('type-test-shop:s1:assets', 'price', {});
      // @ts-expect-error a plain string is not a declared topic
      void publisher.publish(String(Math.random()), 'price', {});
      // @ts-expect-error a route nobody declared has no builder
      topicOf('nosuch', 'x');
    };
    expect(typeof calls).toBe('function');
  });

  it.each([
    ['type-test', 'abc', 'type-test:abc'],
    ['type-test-shop:live', 's1', 'type-test-shop:s1:live'],
  ] as const)('topicOf(%s, %s) builds %s', (route, id, expected) => {
    expect(topicOf(route, id)).toBe(expected);
  });
});
