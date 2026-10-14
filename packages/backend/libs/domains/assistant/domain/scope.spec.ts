import {
  RetrievalScope,
  describeScope,
  passageInScope,
  scopeKey,
} from './scope';

const A = '0192f7a0-0000-7000-8000-00000000a001';
const B = '0192f7a0-0000-7000-8000-00000000b001';
const PA1 = '0192f7a0-0000-7000-8000-00000000c001';
const PA2 = '0192f7a0-0000-7000-8000-00000000c002';
const PB1 = '0192f7a0-0000-7000-8000-00000000c003';

const buyer: RetrievalScope = { kind: 'product', productId: PA1, shopId: A };
const member: RetrievalScope = { kind: 'shop', shopId: A };

// The six documents of the isolation table (AS-35, AS-36).
const D1 = { visibility: 'PUBLIC', shopId: A, productId: PA1 } as const;
const D2 = { visibility: 'PUBLIC', shopId: A, productId: PA2 } as const;
const D3 = { visibility: 'PUBLIC', shopId: A, productId: null } as const;
const D4 = { visibility: 'SHOP_PRIVATE', shopId: A, productId: null } as const;
const D5 = { visibility: 'PUBLIC', shopId: B, productId: PB1 } as const;
const D6 = { visibility: 'PLATFORM', shopId: null, productId: null } as const;
const D7 = { visibility: 'SHOP_PRIVATE', shopId: B, productId: null } as const;

describe('S47 AS-35: retrieval scope (pure)', () => {
  it('S47 AS-35: buyer scope is the product and the shop-level public passages only', () => {
    expect(describeScope(buyer)).toEqual({
      visibilities: ['PUBLIC'],
      shopId: A,
      productId: PA1,
      includePlatform: false,
    });
    const hits = [D1, D2, D3, D4, D5, D6, D7].map((d) =>
      passageInScope(buyer, d),
    );
    expect(hits).toEqual([true, false, true, false, false, false, false]);
  });

  it('S47 AS-36: member scope is platform plus the shop public and private, never another shop', () => {
    expect(describeScope(member)).toEqual({
      visibilities: ['PUBLIC', 'SHOP_PRIVATE'],
      shopId: A,
      productId: null,
      includePlatform: true,
    });
    const hits = [D1, D2, D3, D4, D5, D6, D7].map((d) =>
      passageInScope(member, d),
    );
    expect(hits).toEqual([true, true, true, true, false, true, false]);
  });

  it('S47 AS-36: a platform passage never matches a buyer and a private passage never matches a buyer', () => {
    expect(passageInScope(buyer, D6)).toBe(false);
    expect(passageInScope(buyer, D4)).toBe(false);
  });

  it('S47 AS-35: a scope key is stable and distinguishes the scopes', () => {
    expect(scopeKey(buyer)).not.toBe(scopeKey(member));
    expect(scopeKey(buyer)).toBe(scopeKey({ ...buyer }));
  });
});
