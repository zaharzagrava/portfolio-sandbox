import { validateDefinition, type DefinitionInput } from './flag-validation';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const ctx = { now: NOW };

const base = (): DefinitionInput => ({
  description: 'd',
  owner: 'team',
  enabled: true,
  variants: [
    { key: 'off', value: false },
    { key: 'on', value: true },
  ],
  defaultVariant: 'off',
  offVariant: 'off',
  rules: [
    {
      id: 'r1',
      conditions: [{ attribute: 'country', op: 'in', values: ['DE'] }],
      rollout: [
        { variant: 'on', weight: 500 },
        { variant: 'off', weight: 9_500 },
      ],
    },
  ],
});

const check = (patch: Partial<DefinitionInput>, key = 'new-checkout') =>
  validateDefinition(key, { ...base(), ...patch }, ctx);

describe('flag definition validation', () => {
  it('accepts a valid definition', () => {
    expect(check({})).toEqual([]);
  });

  describe('S38 AS-10: semantic classes with exact path and code', () => {
    it.each<[string, Partial<DefinitionInput>, object[]]>([
      [
        'unknown defaultVariant',
        { defaultVariant: 'nope' },
        [{ path: 'defaultVariant', code: 'unknown_variant' }],
      ],
      [
        'unknown offVariant',
        { offVariant: 'nope' },
        [{ path: 'offVariant', code: 'unknown_variant' }],
      ],
      [
        'unknown rule variant',
        { rules: [{ id: 'r', conditions: [], variant: 'nope' }] },
        [{ path: 'rules[0].variant', code: 'unknown_variant' }],
      ],
      [
        'unknown rollout variant',
        {
          rules: [
            {
              id: 'r',
              conditions: [],
              rollout: [{ variant: 'nope', weight: 10_000 }],
            },
          ],
        },
        [{ path: 'rules[0].rollout[0].variant', code: 'unknown_variant' }],
      ],
      [
        'duplicate variant keys',
        {
          variants: [
            { key: 'off', value: 1 },
            { key: 'off', value: 2 },
          ],
          rules: [],
        },
        [{ path: 'variants[1].key', code: 'duplicate_variant_key' }],
      ],
      [
        'invalid variant key',
        {
          variants: [{ key: 'Off', value: 1 }],
          defaultVariant: 'Off',
          offVariant: 'Off',
          rules: [],
        },
        [{ path: 'variants[0].key', code: 'invalid_variant_key' }],
      ],
      [
        'duplicate rule ids',
        {
          rules: [
            { id: 'a', conditions: [], variant: 'on' },
            { id: 'a', conditions: [], variant: 'on' },
          ],
        },
        [{ path: 'rules[1].id', code: 'duplicate_rule_id' }],
      ],
      [
        'invalid rule id',
        { rules: [{ id: 'A B', conditions: [], variant: 'on' }] },
        [{ path: 'rules[0].id', code: 'invalid_rule_id' }],
      ],
      [
        'rule with both variant and rollout',
        {
          rules: [
            {
              id: 'r',
              conditions: [],
              variant: 'on',
              rollout: [{ variant: 'on', weight: 10_000 }],
            },
          ],
        },
        [{ path: 'rules[0]', code: 'rule_target_invalid' }],
      ],
      [
        'rule with neither variant nor rollout',
        { rules: [{ id: 'r', conditions: [] }] },
        [{ path: 'rules[0]', code: 'rule_target_invalid' }],
      ],
      [
        'weights not summing to 10,000 (actual sum reported)',
        {
          rules: [
            {
              id: 'r',
              conditions: [],
              rollout: [{ variant: 'on', weight: 5_000 }],
            },
          ],
        },
        [{ path: 'rules[0].rollout', code: 'weights_sum_invalid', sum: 5_000 }],
      ],
      [
        'negative weight',
        {
          rules: [
            {
              id: 'r',
              conditions: [],
              rollout: [
                { variant: 'on', weight: -1 },
                { variant: 'off', weight: 10_001 },
              ],
            },
          ],
        },
        [
          { path: 'rules[0].rollout[0].weight', code: 'weight_invalid' },
          {
            path: 'rules[0].rollout',
            code: 'weights_sum_invalid',
            sum: 10_001,
          },
        ],
      ],
      [
        'non-integer weight',
        {
          rules: [
            {
              id: 'r',
              conditions: [],
              rollout: [
                { variant: 'on', weight: 0.5 },
                { variant: 'off', weight: 10_000 },
              ],
            },
          ],
        },
        [{ path: 'rules[0].rollout[0].weight', code: 'weight_invalid' }],
      ],
      [
        'rollout naming a variant twice',
        {
          rules: [
            {
              id: 'r',
              conditions: [],
              rollout: [
                { variant: 'on', weight: 5_000 },
                { variant: 'on', weight: 5_000 },
              ],
            },
          ],
        },
        [
          {
            path: 'rules[0].rollout[1].variant',
            code: 'duplicate_rollout_variant',
          },
        ],
      ],
      [
        'empty rollout',
        { rules: [{ id: 'r', conditions: [], rollout: [] }] },
        [
          { path: 'rules[0].rollout', code: 'rollout_size_invalid' },
          { path: 'rules[0].rollout', code: 'weights_sum_invalid', sum: 0 },
        ],
      ],
      [
        'unknown attribute',
        {
          rules: [
            {
              id: 'r',
              conditions: [{ attribute: 'height', op: 'eq', values: [1] }],
              variant: 'on',
            },
          ],
        },
        [
          {
            path: 'rules[0].conditions[0].attribute',
            code: 'unknown_attribute',
          },
        ],
      ],
      [
        'unknown operator',
        {
          rules: [
            {
              id: 'r',
              conditions: [{ attribute: 'country', op: 'like', values: ['D'] }],
              variant: 'on',
            },
          ],
        },
        [{ path: 'rules[0].conditions[0].op', code: 'unknown_operator' }],
      ],
      [
        'eq with two values',
        {
          rules: [
            {
              id: 'r',
              conditions: [
                { attribute: 'country', op: 'eq', values: ['a', 'b'] },
              ],
              variant: 'on',
            },
          ],
        },
        [
          {
            path: 'rules[0].conditions[0].values',
            code: 'values_arity_invalid',
          },
        ],
      ],
      [
        'in with no values',
        {
          rules: [
            {
              id: 'r',
              conditions: [{ attribute: 'country', op: 'in', values: [] }],
              variant: 'on',
            },
          ],
        },
        [
          {
            path: 'rules[0].conditions[0].values',
            code: 'values_arity_invalid',
          },
        ],
      ],
      [
        'exists with a value',
        {
          rules: [
            {
              id: 'r',
              conditions: [
                { attribute: 'country', op: 'exists', values: ['x'] },
              ],
              variant: 'on',
            },
          ],
        },
        [
          {
            path: 'rules[0].conditions[0].values',
            code: 'values_arity_invalid',
          },
        ],
      ],
      [
        'gte with a string',
        {
          rules: [
            {
              id: 'r',
              conditions: [{ attribute: 'plan', op: 'gte', values: ['5'] }],
              variant: 'on',
            },
          ],
        },
        [
          {
            path: 'rules[0].conditions[0].values[0]',
            code: 'value_type_invalid',
          },
        ],
      ],
      [
        'lte with a boolean',
        {
          rules: [
            {
              id: 'r',
              conditions: [{ attribute: 'plan', op: 'lte', values: [true] }],
              variant: 'on',
            },
          ],
        },
        [
          {
            path: 'rules[0].conditions[0].values[0]',
            code: 'value_type_invalid',
          },
        ],
      ],
      [
        'bucketBy outside the set',
        { bucketBy: 'email' },
        [{ path: 'bucketBy', code: 'bucket_by_invalid' }],
      ],
      [
        'expiresAt in the past',
        { expiresAt: '2026-10-14T11:59:59.000Z' },
        [{ path: 'expiresAt', code: 'expires_at_in_past' }],
      ],
      [
        'expiresAt exactly now',
        { expiresAt: NOW.toISOString() },
        [{ path: 'expiresAt', code: 'expires_at_in_past' }],
      ],
      [
        'expiresAt not a date',
        { expiresAt: 'tomorrow' },
        [{ path: 'expiresAt', code: 'expires_at_invalid' }],
      ],
      [
        'empty owner',
        { owner: '' },
        [{ path: 'owner', code: 'owner_missing' }],
      ],
      [
        'no variants',
        { variants: [], rules: [] },
        [
          { path: 'variants', code: 'variants_missing' },
          { path: 'defaultVariant', code: 'unknown_variant' },
          { path: 'offVariant', code: 'unknown_variant' },
        ],
      ],
    ])('%s', (_name, patch, expected) => {
      expect(check(patch)).toEqual(expected);
    });

    it('an invalid route key', () => {
      expect(check({}, 'Bad Key')).toEqual([
        { path: 'key', code: 'invalid_key' },
      ]);
    });

    it('reports every problem of one request together', () => {
      const codes = check({
        defaultVariant: 'nope',
        rules: [
          { id: 'r', conditions: [], rollout: [{ variant: 'on', weight: 1 }] },
        ],
        bucketBy: 'email',
      }).map((p) => p.code);
      expect(codes).toEqual([
        'bucket_by_invalid',
        'unknown_variant',
        'weights_sum_invalid',
      ]);
    });

    it('an unchanged expiresAt in the past stays valid; a changed one does not', () => {
      const past = '2020-01-01T00:00:00.000Z';
      expect(
        validateDefinition(
          'k-flag',
          { ...base(), expiresAt: past },
          { now: NOW, currentExpiresAt: past },
        ),
      ).toEqual([]);
      expect(
        validateDefinition(
          'k-flag',
          { ...base(), expiresAt: '2021-01-01T00:00:00.000Z' },
          { now: NOW, currentExpiresAt: past },
        ),
      ).toEqual([{ path: 'expiresAt', code: 'expires_at_in_past' }]);
    });
  });

  describe('S38 AS-11: every limit boundary (N accepted, N+1 refused)', () => {
    const variants = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ key: `v${i}`, value: i }));
    const rules = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `r${i}`,
        conditions: [],
        variant: 'v0',
      }));
    const withVariants = (n: number): Partial<DefinitionInput> => ({
      variants: variants(n),
      defaultVariant: 'v0',
      offVariant: 'v0',
      rules: [],
    });
    const withConditions = (n: number): Partial<DefinitionInput> => ({
      rules: [
        {
          id: 'r',
          variant: 'on',
          conditions: Array.from({ length: n }, () => ({
            attribute: 'country',
            op: 'exists',
          })),
        },
      ],
    });
    const withValues = (n: number): Partial<DefinitionInput> => ({
      rules: [
        {
          id: 'r',
          variant: 'on',
          conditions: [
            {
              attribute: 'country',
              op: 'in',
              values: Array.from({ length: n }, (_, i) => `c${i}`),
            },
          ],
        },
      ],
    });
    const withValueBytes = (bytes: number): Partial<DefinitionInput> => ({
      variants: [
        { key: 'off', value: false },
        { key: 'on', value: { s: 'x'.repeat(bytes - '{"s":""}'.length) } },
      ],
    });

    it.each<
      [string, Partial<DefinitionInput>, Partial<DefinitionInput>, string]
    >([
      [
        'variants 20/21',
        withVariants(20),
        withVariants(21),
        'too_many_variants',
      ],
      [
        'rules 50/51',
        { rules: rules(50).map((r) => ({ ...r, variant: 'on' })) },
        { rules: rules(51).map((r) => ({ ...r, variant: 'on' })) },
        'too_many_rules',
      ],
      [
        'conditions 10/11',
        withConditions(10),
        withConditions(11),
        'too_many_conditions',
      ],
      ['values 100/101', withValues(100), withValues(101), 'too_many_values'],
      [
        'variant value 4096/4097 bytes',
        withValueBytes(4096),
        withValueBytes(4097),
        'value_too_large',
      ],
      [
        'description 500/501',
        { description: 'a'.repeat(500) },
        { description: 'a'.repeat(501) },
        'description_too_long',
      ],
      [
        'owner 100/101',
        { owner: 'o'.repeat(100) },
        { owner: 'o'.repeat(101) },
        'owner_too_long',
      ],
    ])('%s', (_name, ok, over, code) => {
      expect(check(ok)).toEqual([]);
      expect(check(over).map((p) => p.code)).toContain(code);
    });
  });
});
