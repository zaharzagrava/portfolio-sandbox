import {
  PRODUCT_STATUSES,
  PRODUCT_TRANSITIONS,
  applyTransition,
} from './product-status';

describe('S05 AS-21: product status machine', () => {
  const legal = new Map<string, string>([
    ['ACTIVE:archive', 'ARCHIVED'],
    ['ARCHIVED:restore', 'ACTIVE'],
  ]);

  const pairs = PRODUCT_STATUSES.flatMap((status) =>
    PRODUCT_TRANSITIONS.map((transition) => [status, transition] as const),
  );

  it('evaluates every (status, transition) pair', () => {
    expect(pairs).toHaveLength(4);
  });

  it.each(pairs)('%s + %s', (status, transition) => {
    const expected = legal.get(`${status}:${transition}`);
    const result = applyTransition(status, transition);
    if (expected) expect(result).toEqual({ ok: true, to: expected });
    else expect(result).toEqual({ ok: false, code: 'invalid_transition' });
  });

  it('only the two legal pairs succeed', () => {
    const accepted = pairs.filter(([s, t]) => applyTransition(s, t).ok);
    expect(accepted).toEqual([
      ['ACTIVE', 'archive'],
      ['ARCHIVED', 'restore'],
    ]);
  });
});
