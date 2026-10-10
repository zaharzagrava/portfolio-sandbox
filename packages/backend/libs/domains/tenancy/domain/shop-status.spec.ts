import { nextState, SHOP_STATUSES, type ShopStatus } from './shop-status';

const LEGAL: Array<[ShopStatus, ShopStatus]> = [
  ['ACTIVE', 'SUSPENDED'],
  ['SUSPENDED', 'ACTIVE'],
  ['ACTIVE', 'DELETING'],
  ['SUSPENDED', 'DELETING'],
  ['DELETING', 'ACTIVE'],
  ['DELETING', 'DELETED'],
];

const ALL = SHOP_STATUSES.flatMap((from) =>
  SHOP_STATUSES.map((to) => [from, to] as const),
);

describe('S03 AS-64 shop status machine', () => {
  it('has four statuses', () => {
    expect([...SHOP_STATUSES]).toEqual([
      'ACTIVE',
      'SUSPENDED',
      'DELETING',
      'DELETED',
    ]);
  });

  it.each(ALL)('%s -> %s', (from, to) => {
    const legal = LEGAL.some(([f, t]) => f === from && t === to);
    const result = nextState(from, to);
    if (legal) expect(result).toEqual({ ok: true, to });
    else expect(result).toEqual({ ok: false, code: 'invalid_transition' });
  });
});
