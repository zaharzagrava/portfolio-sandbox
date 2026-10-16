import { settlementLines } from './settlement-payload';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const lines = [
  { shopId: A, category: 'Phones', lineTotalMinor: 2000 },
  { shopId: B, lineTotalMinor: 500 },
];
const shops = [
  { shopId: A, subtotalMinor: 2000 },
  { shopId: B, subtotalMinor: 500 },
];

describe('Settlement payload', () => {
  it('S14 AS-17: accepts lines that add up to the captured amount and agree with the shop subtotals', () => {
    expect(settlementLines(lines, shops, 2500)).toEqual([
      { shopId: A, category: 'Phones', lineTotalMinor: 2000 },
      { shopId: B, category: '*', lineTotalMinor: 500 },
    ]);
  });

  it.each([
    ['lines that do not add up to the captured amount', lines, shops, 2400],
    [
      'a subtotal that disagrees with its lines',
      lines,
      [shops[0], { shopId: B, subtotalMinor: 400 }],
      2500,
    ],
    ['a shop with lines but no shop order', lines, [shops[0]], 2500],
    ['a duplicate shop order', lines, [shops[0], shops[0], shops[1]], 2500],
    ['no lines', [], shops, 2500],
    [
      'a line without a shop',
      [{ shopId: null, lineTotalMinor: 2500 }],
      shops,
      2500,
    ],
    [
      'a line that is not a uuid shop',
      [{ shopId: 'x', lineTotalMinor: 2500 }],
      shops,
      2500,
    ],
    [
      'a zero order',
      [{ shopId: A, lineTotalMinor: 0 }],
      [{ shopId: A, subtotalMinor: 0 }],
      0,
    ],
  ])('S14 AS-19: refuses %s', (_name, l, s, captured) => {
    expect(settlementLines(l, s, captured)).toBeNull();
  });
});
