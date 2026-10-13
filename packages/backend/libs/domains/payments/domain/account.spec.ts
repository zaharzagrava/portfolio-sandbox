import {
  HOT_ACCOUNTS,
  LEDGER_ACCOUNTS,
  isGuarded,
  parseAccountId,
  shopAccount,
  shopIdOf,
} from './account';

const UUID = '0b9cf0b6-4a6f-4b8e-9d5c-6f0f3c2b9a11';

describe('Account ids and classes', () => {
  it.each([
    ['PROVIDER_CLEARING', 'PROVIDER_CLEARING', true],
    ['MARKETPLACE_CLEARING', 'CLEARING', true],
    ['PLATFORM_FEES', 'PLATFORM_FEES', true],
    ['PAYOUT_CLEARING', 'PAYOUT_CLEARING', false],
    ['PAYOUTS_SENT', 'PAYOUTS_SENT', false],
    [`SHOP_${UUID}`, 'SHOP', false],
  ])(
    'S14 AS-04: %s is a known account of class %s (sharded: %s)',
    (id, cls, sharded) => {
      expect(parseAccountId(id)).toEqual({ id, cls, sharded });
    },
  );

  it('S14 AS-54: the short name CLEARING is accepted for MARKETPLACE_CLEARING', () => {
    expect(parseAccountId('CLEARING')).toEqual({
      id: 'MARKETPLACE_CLEARING',
      cls: 'CLEARING',
      sharded: true,
    });
  });

  it('S14 AS-04: a shop account id is accepted in any case and stored lower-case', () => {
    expect(parseAccountId(`SHOP_${UUID.toUpperCase()}`)?.id).toBe(
      `SHOP_${UUID}`,
    );
  });

  it.each([
    'FOO',
    '',
    'SHOP_',
    'SHOP_not-a-uuid',
    `shop_${UUID}`,
    `MERCHANT_${UUID}`,
    'PROVIDER_FUNDS',
    'PLATFORM_FEES#07',
    'PLATFORM_FEES#0',
    `SHOP_${UUID}#1`,
    ' PLATFORM_FEES',
  ])('S14 AS-04: %j is not an account', (id) => {
    expect(parseAccountId(id)).toBeNull();
  });

  it('S14 AS-04: anything that is not a string is not an account', () => {
    for (const v of [null, undefined, 5, {}, []])
      expect(parseAccountId(v as never)).toBeNull();
  });

  it('S14 AS-22: exactly the three hot accounts are sharded', () => {
    expect([...HOT_ACCOUNTS].sort()).toEqual(
      ['MARKETPLACE_CLEARING', 'PLATFORM_FEES', 'PROVIDER_CLEARING'].sort(),
    );
  });

  it('S14 AS-04: shopAccount and shopIdOf round-trip', () => {
    expect(shopAccount(UUID)).toBe(`SHOP_${UUID}`);
    expect(shopIdOf(`SHOP_${UUID}`)).toBe(UUID);
    expect(shopIdOf('PLATFORM_FEES')).toBeNull();
    expect(LEDGER_ACCOUNTS.CLEARING).toBe('MARKETPLACE_CLEARING');
    expect(LEDGER_ACCOUNTS.PROVIDER_CLEARING).toBe('PROVIDER_CLEARING');
  });

  // delta < 0 is a debit
  it.each([
    ['PAYOUT', `SHOP_${UUID}`, -80, true],
    ['PAYOUT', `SHOP_${UUID}`, 80, false],
    ['PAYOUT_REVERSAL', `SHOP_${UUID}`, -80, false],
    ['AD_CHARGE', `SHOP_${UUID}`, -1000, false],
    ['ADJUSTMENT', `SHOP_${UUID}`, -1000, false],
    ['REFUND', `SHOP_${UUID}`, -1225, false],
    ['SETTLEMENT', `SHOP_${UUID}`, 334, false],
    ['PAYOUT', 'PAYOUT_CLEARING', -50, true],
    ['PAYOUT', 'PAYOUT_CLEARING', 50, true],
    ['ADJUSTMENT', 'PAYOUT_CLEARING', -1, true],
    ['AD_CHARGE', 'PAYOUT_CLEARING', -1, true],
    ['SALE', 'PROVIDER_CLEARING', -2500, false],
    ['REFUND', 'PLATFORM_FEES', -50, false],
    ['REFUND', 'MARKETPLACE_CLEARING', -2450, false],
    ['PAYOUT', 'PAYOUTS_SENT', -5, false],
  ])(
    'S14 AS-10: kind %s, account %s, delta %d is guarded: %s',
    (kind, account, delta, guarded) => {
      const info = parseAccountId(account)!;
      expect(isGuarded(info, kind, delta)).toBe(guarded);
    },
  );
});
