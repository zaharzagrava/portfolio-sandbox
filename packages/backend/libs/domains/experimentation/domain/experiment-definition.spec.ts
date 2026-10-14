import { EXPERIMENT_DEFINITION_ERROR_CODES } from '@marketplace-sandbox/contracts';
import { validateDefinition } from './experiment-definition';

const valid = (patch: Record<string, unknown> = {}) => ({
  owner: 'growth',
  unit: 'visitor' as const,
  variants: [
    { key: 'control', weight: 5_000 },
    { key: 'gallery', weight: 5_000 },
  ],
  layer: 'pdp',
  layerFrom: 0,
  layerTo: 5_000,
  metric: 'add_to_cart',
  ...patch,
});

const weights = (...ws: number[]) =>
  ws.map((weight, i) => ({ key: `v${i}`, weight }));

describe('Experiment definition validation', () => {
  it('S39 AS-32: a valid definition has no problem', () => {
    expect(validateDefinition(valid())).toEqual([]);
    expect(
      validateDefinition(valid({ variants: weights(3_400, 3_300, 3_300) })),
    ).toEqual([]);
    expect(
      validateDefinition(valid({ unit: 'user', metric: 'purchase' })),
    ).toEqual([]);
  });

  it.each([
    [
      'variants_count',
      'one variant',
      { variants: weights(10_000) },
      'variants',
    ],
    ['variants_count', 'no variant', { variants: [] }, 'variants'],
    [
      'variants_count',
      'eleven variants',
      {
        variants: [
          ...weights(...Array(10).fill(900)),
          { key: 'v10', weight: 1_000 },
        ],
      },
      'variants',
    ],
    [
      'variant_key_invalid',
      'an upper-case key',
      {
        variants: [
          { key: 'Control', weight: 5_000 },
          { key: 'b', weight: 5_000 },
        ],
      },
      'variants[0].key',
    ],
    [
      'variant_key_invalid',
      'a key of 33 characters',
      {
        variants: [
          { key: 'a'.repeat(33), weight: 5_000 },
          { key: 'b', weight: 5_000 },
        ],
      },
      'variants[0].key',
    ],
    [
      'variant_key_invalid',
      'an empty key',
      {
        variants: [
          { key: '', weight: 5_000 },
          { key: 'b', weight: 5_000 },
        ],
      },
      'variants[0].key',
    ],
    [
      'variant_key_duplicate',
      'the same key twice',
      {
        variants: [
          { key: 'a', weight: 5_000 },
          { key: 'a', weight: 5_000 },
        ],
      },
      'variants[1].key',
    ],
    [
      'weight_invalid',
      'weight zero',
      {
        variants: [
          { key: 'a', weight: 0 },
          { key: 'b', weight: 10_000 },
        ],
      },
      'variants[0].weight',
    ],
    [
      'weight_invalid',
      'a fractional weight',
      {
        variants: [
          { key: 'a', weight: 5_000.5 },
          { key: 'b', weight: 5_000 },
        ],
      },
      'variants[0].weight',
    ],
    [
      'weight_invalid',
      'a negative weight',
      {
        variants: [
          { key: 'a', weight: -1 },
          { key: 'b', weight: 10_001 },
        ],
      },
      'variants[0].weight',
    ],
    [
      'weights_sum',
      'a sum of 9,999',
      { variants: weights(5_000, 4_999) },
      'variants',
    ],
    [
      'weights_sum',
      'a sum of 10,001',
      { variants: weights(5_000, 5_001) },
      'variants',
    ],
    [
      'layer_range_invalid',
      'from equal to to',
      { layerFrom: 100, layerTo: 100 },
      'layerTo',
    ],
    [
      'layer_range_invalid',
      'from after to',
      { layerFrom: 600, layerTo: 100 },
      'layerTo',
    ],
    [
      'layer_range_invalid',
      'a negative from',
      { layerFrom: -1, layerTo: 100 },
      'layerFrom',
    ],
    [
      'layer_range_invalid',
      'to above 10,000',
      { layerFrom: 0, layerTo: 10_001 },
      'layerTo',
    ],
    [
      'layer_range_invalid',
      'a fractional to',
      { layerFrom: 0, layerTo: 100.5 },
      'layerTo',
    ],
    ['layer_invalid', 'an upper-case layer', { layer: 'PDP' }, 'layer'],
    ['layer_invalid', 'a one-character layer', { layer: 'p' }, 'layer'],
    [
      'layer_invalid',
      'a layer of 33 characters',
      { layer: 'a'.repeat(33) },
      'layer',
    ],
    [
      'metric_unknown',
      'a metric outside the list',
      { metric: 'revenue' },
      'metric',
    ],
    [
      'metric_unknown',
      'exposure as the metric',
      { metric: 'exposure' },
      'metric',
    ],
    [
      'metric_unit_mismatch',
      'purchase for visitors',
      { unit: 'visitor', metric: 'purchase' },
      'metric',
    ],
    ['owner_required', 'an empty owner', { owner: '' }, 'owner'],
    ['owner_required', 'a blank owner', { owner: '   ' }, 'owner'],
  ])('S39 AS-32: %s for %s', (code, _label, patch, path) => {
    expect(validateDefinition(valid(patch))).toEqual([{ path, code }]);
  });

  it('S39 AS-32: boundaries that are valid', () => {
    for (const patch of [
      { layerFrom: 0, layerTo: 1 },
      { layerFrom: 9_999, layerTo: 10_000 },
      { layer: 'ab' },
      { layer: 'a'.repeat(32) },
      {
        variants: [
          { key: 'a'.repeat(32), weight: 9_999 },
          { key: '0_-', weight: 1 },
        ],
      },
      { variants: weights(...Array(10).fill(1_000)) },
      { owner: 'x'.repeat(100) },
    ])
      expect(validateDefinition(valid(patch))).toEqual([]);
  });

  it('S39 AS-32: every problem is reported together, in a stable order', () => {
    const problems = validateDefinition(
      valid({
        owner: '',
        unit: 'visitor',
        metric: 'purchase',
        layer: 'Bad Layer',
        layerFrom: 5,
        layerTo: 5,
        variants: [
          { key: 'A', weight: 0 },
          { key: 'A', weight: 5_000 },
        ],
      }),
    );
    expect(problems).toEqual([
      { path: 'variants[0].key', code: 'variant_key_invalid' },
      { path: 'variants[0].weight', code: 'weight_invalid' },
      { path: 'variants[1].key', code: 'variant_key_invalid' },
      { path: 'variants[1].key', code: 'variant_key_duplicate' },
      { path: 'layer', code: 'layer_invalid' },
      { path: 'layerTo', code: 'layer_range_invalid' },
      { path: 'metric', code: 'metric_unit_mismatch' },
      { path: 'owner', code: 'owner_required' },
    ]);
  });

  it('S39 AS-32: every code of the contract list is produced by some input', () => {
    const seen = new Set(
      [
        valid({ variants: weights(10_000) }),
        valid({
          variants: [
            { key: 'A', weight: 5_000 },
            { key: 'b', weight: 5_000 },
          ],
        }),
        valid({
          variants: [
            { key: 'a', weight: 5_000 },
            { key: 'a', weight: 5_000 },
          ],
        }),
        valid({
          variants: [
            { key: 'a', weight: 0 },
            { key: 'b', weight: 10_000 },
          ],
        }),
        valid({ variants: weights(5_000, 4_000) }),
        valid({ layerFrom: 9, layerTo: 9 }),
        valid({ layer: 'X' }),
        valid({ metric: 'nope' }),
        valid({ metric: 'purchase' }),
        valid({ owner: '' }),
      ].flatMap((def) => validateDefinition(def).map((p) => p.code)),
    );
    expect([...seen].sort()).toEqual(
      [...EXPERIMENT_DEFINITION_ERROR_CODES].sort(),
    );
  });
});
