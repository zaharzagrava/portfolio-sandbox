import { isOfferVisible, type OfferFacts } from './offer-visibility';

const visible: OfferFacts = {
  quantity: 1,
  pointActive: true,
  shopStatus: 'ACTIVE',
  productStatus: 'ACTIVE',
  isSandbox: false,
};

describe('S19 AS-06 offer visibility', () => {
  it('shows the offer when every condition holds', () => {
    expect(isOfferVisible(visible)).toBe(true);
  });

  it.each([
    ['no stock', { quantity: 0 }],
    ['negative stock', { quantity: -1 }],
    ['inactive point', { pointActive: false }],
    ['suspended shop', { shopStatus: 'SUSPENDED' }],
    ['shop being deleted', { shopStatus: 'DELETING' }],
    ['deleted shop', { shopStatus: 'DELETED' }],
    ['no shop copy yet', { shopStatus: null }],
    ['archived product', { productStatus: 'ARCHIVED' }],
    ['no product copy yet', { productStatus: null }],
    ['sandbox product', { isSandbox: true }],
  ] as [string, Partial<OfferFacts>][])(
    'hides the offer: %s',
    (_name, change) => {
      expect(isOfferVisible({ ...visible, ...change })).toBe(false);
    },
  );

  it('is the conjunction over every combination of the five inputs', () => {
    const quantities = [0, 3];
    const flags = [true, false];
    const shops = ['ACTIVE', 'SUSPENDED', null];
    const products = ['ACTIVE', 'ARCHIVED', null];
    for (const quantity of quantities)
      for (const pointActive of flags)
        for (const shopStatus of shops)
          for (const productStatus of products)
            for (const isSandbox of flags) {
              const expected =
                quantity > 0 &&
                pointActive &&
                shopStatus === 'ACTIVE' &&
                productStatus === 'ACTIVE' &&
                !isSandbox;
              expect(
                isOfferVisible({
                  quantity,
                  pointActive,
                  shopStatus,
                  productStatus,
                  isSandbox,
                }),
              ).toBe(expected);
            }
  });
});
