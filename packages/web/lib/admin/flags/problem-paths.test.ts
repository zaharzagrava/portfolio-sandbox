import { describe, expect, it } from 'vitest';
import { FLAG_DEFINITION_ERROR_CODES, FLAG_LIMITS } from '@marketplace-sandbox/contracts';
import { definitionErrorCopy, fieldForPath } from './problem-paths';

describe('fieldForPath', () => {
  it.each([
    ['key', 'flag-key', 'Key'],
    ['description', 'flag-description', 'Description'],
    ['owner', 'flag-owner', 'Owner'],
    ['expiresAt', 'flag-expires-at', 'Expires'],
    ['defaultVariant', 'flag-default-variant', 'Default variant'],
    ['offVariant', 'flag-off-variant', 'Off variant'],
    ['bucketBy', 'flag-bucket-by', 'Bucket by'],
    ['variants', 'flag-variants', 'Variants'],
    ['variants[2].value', 'variant-2-value', 'Variant 3 value'],
    ['variants[0].key', 'variant-0-key', 'Variant 1 key'],
    ['rules[0].rollout', 'rule-0-rollout', 'Rule 1 rollout'],
    ['rules[1].variant', 'rule-1-outcome', 'Rule 2 variant'],
    ['rules[1].id', 'rule-1-id', 'Rule 2 id'],
    ['rules[3].conditions[1].values', 'rule-3-condition-1-values', 'Rule 4 condition 2 values'],
    ['rules[3].conditions[1].op', 'rule-3-condition-1-op', 'Rule 4 condition 2 operator'],
    ['rules[0].rollout[1].weight', 'rule-0-rollout', 'Rule 1 rollout'],
  ])('W06 AS-14: %s → %s', (path, id, label) => {
    expect(fieldForPath(path)).toEqual({ id, label });
  });

  it('W06 FR-050: an unknown path has no field (the summary lists it)', () => {
    expect(fieldForPath('somethingNew')).toBeNull();
    expect(fieldForPath('rules[x].id')).toBeNull();
    expect(fieldForPath('')).toBeNull();
  });
});

describe('definitionErrorCopy', () => {
  it('W06 AS-14: weights_sum_invalid quotes the sum in percent', () => {
    expect(definitionErrorCopy('weights_sum_invalid', { sum: 9000 })).toEqual({ message: 'Weights must add up to 100%. They add up to 90%.' });
    expect(definitionErrorCopy('weights_sum_invalid', { sum: 10050 }).message).toBe('Weights must add up to 100%. They add up to 100.5%.');
    expect(definitionErrorCopy('weights_sum_invalid').message).toBe('Weights must add up to 100%.');
  });

  it('W06 FR-050: limit messages quote the contract limits, never literals', () => {
    expect(definitionErrorCopy('too_many_variants').message).toBe(`A flag can have at most ${FLAG_LIMITS.variants} variants.`);
    expect(definitionErrorCopy('too_many_rules').message).toBe(`A flag can have at most ${FLAG_LIMITS.rules} rules.`);
    expect(definitionErrorCopy('too_many_conditions').message).toBe(`A rule can have at most ${FLAG_LIMITS.conditions} conditions.`);
    expect(definitionErrorCopy('too_many_values').message).toBe(`A condition can list at most ${FLAG_LIMITS.values} values.`);
    expect(definitionErrorCopy('value_too_large').message).toBe(`This value is too large (${FLAG_LIMITS.valueBytes / 1024} KiB at most).`);
    expect(definitionErrorCopy('description_too_long').message).toBe(`Description can be at most ${FLAG_LIMITS.description} characters.`);
    expect(definitionErrorCopy('owner_too_long').message).toBe(`Owner can be at most ${FLAG_LIMITS.owner} characters.`);
  });

  it('W06 FR-050: every code of the contracts has copy and an unknown code says so with the code in the title', () => {
    for (const code of FLAG_DEFINITION_ERROR_CODES) expect(definitionErrorCopy(code).message.length).toBeGreaterThan(0);
    expect(definitionErrorCopy('brand_new_code')).toEqual({ message: "This value isn't valid.", title: 'brand_new_code' });
  });
});
