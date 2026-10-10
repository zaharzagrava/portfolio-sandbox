import fc from 'fast-check';
import { checkPaymentMoney } from './payment-amount';

describe('S13 AS-13: payment amount and currency rules', () => {
  it.each([
    [0, 'amount_out_of_range'],
    [1, 'ok'],
    [99_999_999, 'ok'],
    [100_000_000, 'amount_out_of_range'],
    [-5, 'amount_out_of_range'],
    [10.5, 'amount_out_of_range'],
    [Number.NaN, 'amount_out_of_range'],
  ])('amount %p -> %s', (amount, expected) => {
    expect(checkPaymentMoney(amount, 'EUR').kind).toBe(expected);
  });

  it.each([
    ['EUR', 'ok'],
    ['USD', 'ok'],
    ['GBP', 'ok'],
    ['JPY', 'currency_unsupported'],
    ['BHD', 'currency_unsupported'],
    ['eur', 'currency_unsupported'],
    ['', 'currency_unsupported'],
  ])('currency %p -> %s', (currency, expected) => {
    expect(checkPaymentMoney(1_000, currency).kind).toBe(expected);
  });

  it('property: any in-range amount in any supported currency is accepted, anything outside is refused', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99_999_999 }),
        fc.constantFrom('EUR', 'USD', 'GBP'),
        (amount, currency) => checkPaymentMoney(amount, currency).kind === 'ok',
      ),
    );
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -1_000_000, max: 0 }),
          fc.integer({ min: 100_000_000, max: 2_000_000_000 }),
        ),
        fc.constantFrom('EUR', 'USD', 'GBP'),
        (amount, currency) =>
          checkPaymentMoney(amount, currency).kind === 'amount_out_of_range',
      ),
    );
  });
});
