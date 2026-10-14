import { decideShopCopy, isShopActive } from './shop-copy';

describe('S44 AS-42 shop copy version guard', () => {
  it.each([
    [5, 6, 'apply'],
    [5, 100, 'apply'],
    [0, 1, 'apply'],
    [5, 5, 'ignore'],
    [5, 4, 'ignore'],
    [5, 0, 'ignore'],
  ] as const)(
    'S44 AS-42: stored %i, incoming %i -> %s',
    (stored, incoming, expected) => {
      expect(decideShopCopy(stored, incoming)).toBe(expected);
    },
  );

  it('S44 AS-42: a version that is not a safe integer is ignored', () => {
    expect(decideShopCopy(5, Number.NaN)).toBe('ignore');
    expect(decideShopCopy(5, 6.5)).toBe('ignore');
    expect(decideShopCopy(5, Number.POSITIVE_INFINITY)).toBe('ignore');
  });
});

describe('S44 AS-43 shop status', () => {
  it.each([
    ['ACTIVE', true],
    ['SUSPENDED', false],
    ['DELETING', false],
    ['DELETED', false],
    ['', false],
    ['active', false],
  ] as const)('S44 AS-43: %s -> active %s', (status, active) => {
    expect(isShopActive(status)).toBe(active);
  });
});
