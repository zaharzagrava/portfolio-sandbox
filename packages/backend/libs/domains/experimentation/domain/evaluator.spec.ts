import {
  bucketOf,
  evaluate,
  type Condition,
  type EvalContext,
  type FlagDefinition,
} from './evaluator';

/** The evaluator runs inside every service (local SDK) and in the client endpoint - pure → unit spec. */
describe('flag evaluator', () => {
  const checkout = (percent: number): FlagDefinition => ({
    key: 'new-checkout',
    status: 'enabled',
    variants: [
      { key: 'off', value: false },
      { key: 'on', value: true },
    ],
    defaultVariant: 'off',
    offVariant: 'off',
    bucketBy: 'userId',
    version: 3,
    rules: [
      {
        id: 'staff',
        conditions: [
          { attribute: 'email_domain', op: 'in', values: ['marketplace.dev'] },
        ],
        variant: 'on',
      },
      {
        id: 'blocked-countries',
        conditions: [{ attribute: 'country', op: 'in', values: ['XX'] }],
        variant: 'off',
      },
      {
        id: 'rollout',
        conditions: [],
        rollout: [
          { variant: 'on', weight: percent * 100 },
          { variant: 'off', weight: 10_000 - percent * 100 },
        ],
      },
    ],
  });
  const users = Array.from({ length: 20_000 }, (_, i) => `user-${i}`);

  it.each([
    [1, 2],
    [2, 3],
    [5, 6],
    [10, 11],
    [20, 21],
    [50, 51],
    [99, 100],
  ])('S38 AS-03: widening %i%% → %i%% only adds users', (narrow, wide) => {
    const on = (percent: number) =>
      new Set(
        users.filter(
          (u) => evaluate(checkout(percent), { userId: u }).value === true,
        ),
      );
    const before = on(narrow);
    const after = on(wide);
    expect([...before].every((u) => after.has(u))).toBe(true);
    expect(after.size).toBeGreaterThanOrEqual(before.size);
  });

  it('rollout share ≈ configured percentage and is sticky per user', () => {
    const on = users.filter(
      (u) => evaluate(checkout(25), { userId: u }).value === true,
    ).length;
    expect(on / users.length).toBeGreaterThan(0.23);
    expect(on / users.length).toBeLessThan(0.27);
    expect(evaluate(checkout(25), { userId: 'user-7' })).toEqual(
      evaluate(checkout(25), { userId: 'user-7' }),
    );
  });

  describe('S38 AS-13: status, rule order and results', () => {
    it.each<[string, FlagDefinition, EvalContext, object]>([
      [
        'disabled serves the off variant, reason off',
        { ...checkout(100), status: 'disabled' },
        { userId: 'u' },
        { variant: 'off', value: false, reason: 'off', flagVersion: 3 },
      ],
      [
        'killed serves the off variant, reason killed (rules ignored)',
        { ...checkout(100), status: 'killed' },
        { userId: 'u', email_domain: 'marketplace.dev' },
        { variant: 'off', value: false, reason: 'killed', flagVersion: 3 },
      ],
      [
        'the first matching rule wins even when a later one matches too',
        checkout(100),
        { userId: 'u', email_domain: 'marketplace.dev', country: 'XX' },
        { variant: 'on', reason: 'rule', ruleId: 'staff' },
      ],
      [
        'a later rule decides when the first does not match',
        checkout(100),
        { userId: 'u', country: 'XX' },
        { variant: 'off', reason: 'rule', ruleId: 'blocked-countries' },
      ],
      [
        'no matching rule serves the default, reason default',
        { ...checkout(0), rules: [] },
        { userId: 'u' },
        { variant: 'off', reason: 'default' },
      ],
      [
        'all conditions of a rule must hold',
        {
          ...checkout(0),
          rules: [
            {
              id: 'both',
              conditions: [
                { attribute: 'country', op: 'eq', values: ['DE'] },
                { attribute: 'platform', op: 'eq', values: ['ios'] },
              ],
              variant: 'on',
            },
          ],
        },
        { userId: 'u', country: 'DE', platform: 'web' },
        { variant: 'off', reason: 'default' },
      ],
    ])('%s', (_name, flag, ctx, expected) => {
      expect(evaluate(flag, ctx)).toMatchObject(expected);
    });

    const withCondition = (condition: Condition): FlagDefinition => ({
      ...checkout(0),
      rules: [{ id: 'c', conditions: [condition], variant: 'on' }],
    });
    const hit = (condition: Condition, ctx: EvalContext) =>
      evaluate(withCondition(condition), ctx).variant === 'on';

    it.each<[string, Condition, EvalContext, boolean]>([
      [
        'in, present and listed',
        { attribute: 'country', op: 'in', values: ['DE', 'FR'] },
        { country: 'DE' },
        true,
      ],
      [
        'in, present and not listed',
        { attribute: 'country', op: 'in', values: ['DE'] },
        { country: 'US' },
        false,
      ],
      [
        'in, absent',
        { attribute: 'country', op: 'in', values: ['DE'] },
        {},
        false,
      ],
      [
        'in, array with one listed element',
        { attribute: 'role', op: 'in', values: ['ADMIN'] },
        { role: ['USER', 'ADMIN'] },
        true,
      ],
      [
        'in, array with no listed element',
        { attribute: 'role', op: 'in', values: ['ADMIN'] },
        { role: ['USER'] },
        false,
      ],
      [
        'not_in, present and listed',
        { attribute: 'country', op: 'not_in', values: ['DE'] },
        { country: 'DE' },
        false,
      ],
      [
        'not_in, present and not listed',
        { attribute: 'country', op: 'not_in', values: ['DE'] },
        { country: 'US' },
        true,
      ],
      [
        'not_in, absent',
        { attribute: 'country', op: 'not_in', values: ['DE'] },
        {},
        true,
      ],
      [
        'not_in, array with a listed element',
        { attribute: 'role', op: 'not_in', values: ['ADMIN'] },
        { role: ['USER', 'ADMIN'] },
        false,
      ],
      [
        'not_in, array with no listed element',
        { attribute: 'role', op: 'not_in', values: ['ADMIN'] },
        { role: ['USER'] },
        true,
      ],
      [
        'eq, equal',
        { attribute: 'platform', op: 'eq', values: ['ios'] },
        { platform: 'ios' },
        true,
      ],
      [
        'eq, different',
        { attribute: 'platform', op: 'eq', values: ['ios'] },
        { platform: 'web' },
        false,
      ],
      [
        'eq, absent',
        { attribute: 'platform', op: 'eq', values: ['ios'] },
        {},
        false,
      ],
      [
        'neq, different',
        { attribute: 'platform', op: 'neq', values: ['ios'] },
        { platform: 'web' },
        true,
      ],
      [
        'neq, equal',
        { attribute: 'platform', op: 'neq', values: ['ios'] },
        { platform: 'ios' },
        false,
      ],
      [
        'neq, absent',
        { attribute: 'platform', op: 'neq', values: ['ios'] },
        {},
        true,
      ],
      [
        'gte, number above',
        { attribute: 'age', op: 'gte', values: [18] },
        { age: 20 },
        true,
      ],
      [
        'gte, number equal',
        { attribute: 'age', op: 'gte', values: [18] },
        { age: 18 },
        true,
      ],
      [
        'gte, number below',
        { attribute: 'age', op: 'gte', values: [18] },
        { age: 17 },
        false,
      ],
      [
        'gte, string',
        { attribute: 'age', op: 'gte', values: [18] },
        { age: '20' },
        false,
      ],
      ['gte, absent', { attribute: 'age', op: 'gte', values: [18] }, {}, false],
      [
        'lte, number below',
        { attribute: 'age', op: 'lte', values: [18] },
        { age: 3 },
        true,
      ],
      [
        'lte, number above',
        { attribute: 'age', op: 'lte', values: [18] },
        { age: 19 },
        false,
      ],
      [
        'lte, string',
        { attribute: 'age', op: 'lte', values: [18] },
        { age: '3' },
        false,
      ],
      ['lte, absent', { attribute: 'age', op: 'lte', values: [18] }, {}, false],
      [
        'exists, present',
        { attribute: 'country', op: 'exists' },
        { country: 'DE' },
        true,
      ],
      [
        'exists, empty string',
        { attribute: 'country', op: 'exists' },
        { country: '' },
        false,
      ],
      ['exists, absent', { attribute: 'country', op: 'exists' }, {}, false],
    ])('operator %s', (_name, condition, ctx, expected) => {
      expect(hit(condition, ctx)).toBe(expected);
    });
  });

  it('S38 AS-15: different flags bucket independently (20,000 users, few collisions)', () => {
    const same = users.filter(
      (u) => bucketOf('flag-a', u) === bucketOf('flag-b', u),
    ).length;
    expect(same).toBeLessThan(20); // ~2 expected by chance
  });

  describe('S38 AS-16: rollout without a usable unit serves the first slice', () => {
    it.each<[string, EvalContext, 'userId' | 'shopId']>([
      ['anonymous, no userId', {}, 'userId'],
      ['empty userId', { userId: '' }, 'userId'],
      ['no shop for a shop-bucketed flag', { userId: 'u' }, 'shopId'],
    ])('%s', (_name, ctx, bucketBy) => {
      const flag: FlagDefinition = {
        ...checkout(0),
        bucketBy,
        rules: [
          {
            id: 'r',
            conditions: [],
            rollout: [
              { variant: 'off', weight: 1 },
              { variant: 'on', weight: 9_999 },
            ],
          },
        ],
      };
      expect(evaluate(flag, ctx)).toMatchObject({
        variant: 'off',
        reason: 'rollout',
        ruleId: 'r',
      });
    });
  });

  it('S38 AS-52: shop allowlist and plan targeting → on, on, off', () => {
    const flag: FlagDefinition = {
      ...checkout(0),
      bucketBy: 'shopId',
      rules: [
        {
          id: 'allow',
          conditions: [{ attribute: 'shopId', op: 'in', values: ['shop-a'] }],
          variant: 'on',
        },
        {
          id: 'pro-c',
          conditions: [
            { attribute: 'shopId', op: 'eq', values: ['shop-c'] },
            { attribute: 'plan', op: 'eq', values: ['PRO'] },
          ],
          variant: 'on',
        },
      ],
    };
    expect(evaluate(flag, { shopId: 'shop-a' }).variant).toBe('on');
    expect(evaluate(flag, { shopId: 'shop-c', plan: 'PRO' }).variant).toBe(
      'on',
    );
    expect(evaluate(flag, { shopId: 'shop-c', plan: 'STARTER' }).variant).toBe(
      'off',
    );
  });

  it('S38 AS-17: a missing flag is unknown_flag carrying the asked key', () => {
    expect(evaluate(undefined, { userId: 'u' }, 'nope')).toEqual({
      key: 'nope',
      variant: 'off',
      value: false,
      reason: 'unknown_flag',
      flagVersion: 0,
    });
  });
});
