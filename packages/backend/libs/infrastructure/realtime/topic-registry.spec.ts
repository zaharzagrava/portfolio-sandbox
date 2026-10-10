import {
  DuplicateTopicRouteError,
  InvalidTopicDefinitionError,
  TopicRegistry,
  TopicRegistryFrozenError,
  type TopicDefinition,
} from './topic-registry';

const allow = () => true;

describe('S51 TopicRegistry definitions', () => {
  it.each<[string, TopicDefinition]>([
    ['a bare prefix', { prefix: 'auction', policy: allow }],
    ['a hyphenated prefix', { prefix: 'order-export', policy: allow }],
    [
      'a prefix with suffixes',
      { prefix: 'shop', suffixes: ['live', 'assets'], policy: allow },
    ],
    ['a singleton', { prefix: 'flags', singleton: true, policy: allow }],
    ['an owner label', { prefix: 'chat', owner: 'chat', policy: allow }],
  ])('S51 AS-64: accepts %s', (_label, definition) => {
    expect(() => new TopicRegistry().define(definition)).not.toThrow();
  });

  it.each<[string, Partial<TopicDefinition> & { prefix: string }]>([
    ['an upper-case prefix', { prefix: 'Auction', policy: allow }],
    ['a 33-character prefix', { prefix: 'a'.repeat(33), policy: allow }],
    ['an empty prefix', { prefix: '', policy: allow }],
    [
      'an illegal suffix',
      { prefix: 'shop', suffixes: ['Live!'], policy: allow },
    ],
    ['an empty suffix list', { prefix: 'shop', suffixes: [], policy: allow }],
    ['a missing rule', { prefix: 'auction' }],
    [
      'a singleton with suffixes',
      { prefix: 'flags', singleton: true, suffixes: ['x'], policy: allow },
    ],
  ])('S51 AS-64: rejects %s', (_label, definition) => {
    expect(() =>
      new TopicRegistry().define(definition as TopicDefinition),
    ).toThrow(InvalidTopicDefinitionError);
  });

  it('S51 AS-63: the same route twice is an error naming the route', () => {
    const registry = new TopicRegistry();
    registry.define({ prefix: 'shop', suffixes: ['live'], policy: allow });
    expect(() =>
      registry.define({ prefix: 'shop', suffixes: ['live'], policy: allow }),
    ).toThrow(DuplicateTopicRouteError);
    expect(() =>
      registry.define({ prefix: 'shop', suffixes: ['live'], policy: allow }),
    ).toThrow(/shop:live/);
  });

  it('S51 AS-62: routes of one prefix coexist and each keeps its own rule', async () => {
    const registry = new TopicRegistry();
    registry.define({ prefix: 'shop', suffixes: ['live'], policy: () => true });
    registry.define({
      prefix: 'shop',
      suffixes: ['assets'],
      policy: () => false,
    });
    expect(await registry.canSubscribe({}, 'shop:X:live')).toBe(true);
    expect(await registry.canSubscribe({}, 'shop:X:assets')).toBe(false);
    expect(registry.isKnown('shop:X')).toBe(false);
    expect(registry.isKnown('shop:X:other')).toBe(false);
  });

  it('S51 AS-11/AS-25: the rule receives (viewer, topic, id, suffix) and may be asynchronous', async () => {
    const registry = new TopicRegistry();
    const policy = jest.fn(async () => true);
    registry.define({ prefix: 'shop', suffixes: ['live'], policy });
    const viewer = { userId: 'u1', roles: ['USER'] };
    await registry.canSubscribe(viewer, 'shop:S1:live');
    expect(policy).toHaveBeenCalledWith(viewer, 'shop:S1:live', 'S1', 'live');
  });

  it('S51 AS-13: an undefined route is unknown and denied', async () => {
    const registry = new TopicRegistry();
    expect(registry.isKnown('nosuch:1')).toBe(false);
    expect(await registry.canSubscribe({}, 'nosuch:1')).toBe(false);
  });
});

describe('S51 AS-65 registry freeze', () => {
  it('defines before the freeze work and after it throw TopicRegistryFrozenError', () => {
    const registry = new TopicRegistry();
    registry.define({ prefix: 'auction', policy: allow });
    registry.freeze();
    expect(() => registry.define({ prefix: 'late', policy: allow })).toThrow(
      TopicRegistryFrozenError,
    );
    expect(registry.isKnown('auction:a1')).toBe(true);
    expect(registry.isKnown('late:a1')).toBe(false);
  });
});
