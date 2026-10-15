import { validateProviderAnswer } from './provider-answer';

const expected = {
  amountMinor: 45_000,
  currency: 'EUR',
  destination: 'acct_12345678',
};
const good = {
  id: 'tr_abc123',
  amount: 45_000,
  currency: 'eur',
  destination: 'acct_12345678',
};

describe('provider answer validation (S15 AS-25)', () => {
  it('S15 AS-25: an answer that matches the request yields its reference', () => {
    expect(validateProviderAnswer(expected, good)).toEqual({
      ok: true,
      transferRef: 'tr_abc123',
    });
  });

  it('S15 AS-25: the currency compares without regard to case', () => {
    expect(
      validateProviderAnswer(expected, { ...good, currency: 'EUR' }),
    ).toEqual({ ok: true, transferRef: 'tr_abc123' });
  });

  it.each([
    ['a different amount', { ...good, amount: 44_999 }, 'amount'],
    ['an amount that is not a number', { ...good, amount: '45000' }, 'amount'],
    ['a different currency', { ...good, currency: 'usd' }, 'currency'],
    ['a missing currency', { ...good, currency: undefined }, 'currency'],
    [
      'a different destination',
      { ...good, destination: 'acct_99999999' },
      'destination',
    ],
    [
      'a missing destination',
      { ...good, destination: undefined },
      'destination',
    ],
    ['an empty reference', { ...good, id: '' }, 'missing_transfer'],
    ['a missing reference', { ...good, id: undefined }, 'missing_transfer'],
    ['a non-string reference', { ...good, id: 42 }, 'missing_transfer'],
    ['null', null, 'missing_transfer'],
    ['a string', 'ok', 'missing_transfer'],
    ['an array', [good], 'missing_transfer'],
    ['undefined', undefined, 'missing_transfer'],
  ])('S15 AS-25: %s is refused as %s', (_label, answer, kind) => {
    expect(validateProviderAnswer(expected, answer)).toEqual({
      ok: false,
      kind,
    });
  });

  it('S15 AS-25: the first difference in the order amount, currency, destination is reported', () => {
    expect(
      validateProviderAnswer(expected, {
        id: 'tr_1',
        amount: 1,
        currency: 'usd',
        destination: 'acct_x',
      }),
    ).toEqual({ ok: false, kind: 'amount' });
  });
});
