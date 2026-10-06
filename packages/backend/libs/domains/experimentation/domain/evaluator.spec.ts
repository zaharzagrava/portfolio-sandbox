import { bucketOf, evaluate, FlagDefinition, validateFlag } from './evaluator';
import { murmur3 } from '@app/common/core/murmur3';

/** The evaluator runs inside every service (local SDK) and in the client endpoint - pure → unit spec. */
describe('flag evaluator', () => {
  const checkout = (percent: number): FlagDefinition => ({
    key: 'new-checkout',
    enabled: true,
    variants: [
      { key: 'off', value: false },
      { key: 'on', value: true },
    ],
    defaultVariant: 'off',
    offVariant: 'off',
    bucketBy: 'userId',
    version: 1,
    rules: [
      { id: 'staff', conditions: [{ attribute: 'email_domain', op: 'in', values: ['marketplace.dev'] }], variant: 'on' },
      { id: 'blocked-countries', conditions: [{ attribute: 'country', op: 'in', values: ['XX'] }], variant: 'off' },
      { id: 'rollout', conditions: [], rollout: [{ variant: 'on', weight: percent * 100 }, { variant: 'off', weight: 10_000 - percent * 100 }] },
    ],
  });
  const users = Array.from({ length: 20_000 }, (_, i) => `user-${i}`);

  it('murmur3 matches the reference vectors (cross-SDK consistency)', () => {
    expect(murmur3('')).toBe(0);
    expect(murmur3('hello')).toBe(613153351);
    expect(murmur3('The quick brown fox jumps over the lazy dog')).toBe(0x2e4ff723);
  });

  it('rollout share ≈ configured percentage and is sticky per user', () => {
    const on = users.filter((u) => evaluate(checkout(25), { userId: u }).value === true).length;
    expect(on / users.length).toBeGreaterThan(0.23);
    expect(on / users.length).toBeLessThan(0.27);
    expect(evaluate(checkout(25), { userId: 'user-7' })).toEqual(evaluate(checkout(25), { userId: 'user-7' }));
  });

  it('widening the rollout only adds users', () => {
    const at5 = new Set(users.filter((u) => evaluate(checkout(5), { userId: u }).value));
    const at20 = new Set(users.filter((u) => evaluate(checkout(20), { userId: u }).value));
    expect([...at5].every((u) => at20.has(u))).toBe(true);
  });

  it('first matching rule wins; disabled serves the off variant; different flags bucket independently', () => {
    expect(evaluate(checkout(0), { userId: 'u', email_domain: 'marketplace.dev' })).toMatchObject({ value: true, reason: 'rule', ruleId: 'staff' });
    expect(evaluate(checkout(100), { userId: 'u', country: 'XX' })).toMatchObject({ value: false, ruleId: 'blocked-countries' });
    expect(evaluate({ ...checkout(100), enabled: false }, { userId: 'u' })).toMatchObject({ value: false, reason: 'off' });
    const same = users.filter((u) => bucketOf('flag-a', u) === bucketOf('flag-b', u)).length;
    expect(same).toBeLessThan(20); // ~2 expected by chance
  });

  it('validates weights and variant references', () => {
    expect(validateFlag({ ...checkout(25), rules: [{ id: 'r', conditions: [], rollout: [{ variant: 'on', weight: 5_000 }] }] })).toEqual(['rule r: rollout weights sum to 5000, expected 10000']);
    expect(validateFlag({ ...checkout(25), defaultVariant: 'nope' })).toEqual(['unknown variant nope']);
  });
});
