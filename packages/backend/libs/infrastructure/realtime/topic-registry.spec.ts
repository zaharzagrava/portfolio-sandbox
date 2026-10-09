import { TopicRegistry } from './topic-registry';

/**
 * D-3 parity: the registry, filled the way the domains fill it in the SSE gateway, must accept exactly the topics
 * the former hard-coded pattern accepted, and keep the former default policies.
 */
const FORMER_PATTERN =
  /^(user|shop|auction|event|queue|stream|delivery|job|chat):[A-Za-z0-9_-]{1,64}(:(live|seatmap))?$|^flags$/;

function gatewayRegistry(): TopicRegistry {
  const r = new TopicRegistry();
  const member = () => false; // SQL-backed policies: covered by e2e, irrelevant to topic validation
  r.define({ prefix: 'user', policy: (v, _t, id) => v.userId === id }); // identity
  r.define({ prefix: 'shop', suffixes: ['live'], policy: member }); // tenancy
  r.define({ prefix: 'auction', policy: () => true }); // auctions
  r.define({ prefix: 'event', suffixes: ['seatmap'], policy: () => true }); // launch-events
  r.define({ prefix: 'queue', policy: () => true });
  r.define({ prefix: 'stream', policy: () => true });
  r.define({
    prefix: 'flags',
    singleton: true,
    policy: (v) => v.roles?.includes('SERVICE') ?? false,
  }); // experimentation
  r.define({ prefix: 'chat', policy: member }); // chat
  r.define({ prefix: 'delivery', policy: member }); // fulfilment
  r.define({ prefix: 'job', policy: member }); // catalog-sync (imports)
  r.define({ prefix: 'job', policy: (v) => v.userId === 'exporter' }); // orders (exports): ORed with imports
  return r;
}

describe('TopicRegistry (realtime, debt D-3)', () => {
  const registry = gatewayRegistry();

  const samples = [
    'user:abc',
    'user:abc:live',
    'shop:9f2c:live',
    'shop:9f2c',
    'auction:a1',
    'event:e-1:seatmap',
    'event:e-1',
    'queue:t_1',
    'stream:s1',
    'delivery:d1',
    'job:j1',
    'chat:c1',
    'flags',
    'flags:x',
    'unknown:x',
    'user:',
    'user:' + 'x'.repeat(64),
    'user:' + 'x'.repeat(65),
    'auction:a1:other',
    'auction:a.1',
    'USER:abc',
    'user:abc:live:extra',
  ];

  it.each(samples)(
    'accepts %s exactly when the former pattern did',
    (topic) => {
      expect(registry.isKnown(topic)).toBe(FORMER_PATTERN.test(topic));
    },
  );

  it('keeps the former default policies', async () => {
    expect(await registry.canSubscribe({ userId: 'u1' }, 'user:u1')).toBe(true);
    expect(await registry.canSubscribe({ userId: 'u1' }, 'user:u2')).toBe(
      false,
    );
    expect(await registry.canSubscribe({}, 'auction:a1')).toBe(true);
    expect(await registry.canSubscribe({}, 'event:e1:seatmap')).toBe(true);
    expect(await registry.canSubscribe({}, 'queue:t1')).toBe(true);
    expect(await registry.canSubscribe({}, 'stream:s1')).toBe(true);
    expect(await registry.canSubscribe({ roles: ['SERVICE'] }, 'flags')).toBe(
      true,
    );
    expect(await registry.canSubscribe({ roles: ['USER'] }, 'flags')).toBe(
      false,
    );
  });

  it('ORs several definitions of one prefix and denies undefined prefixes', async () => {
    expect(await registry.canSubscribe({ userId: 'exporter' }, 'job:j1')).toBe(
      true,
    );
    expect(await registry.canSubscribe({ userId: 'someone' }, 'job:j1')).toBe(
      false,
    );
    expect(await registry.canSubscribe({ userId: 'u1' }, 'unknown:x')).toBe(
      false,
    );
  });
});
