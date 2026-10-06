import { isValidIban, isValidVat, maskIban, namesMatch } from './validators';

describe('isValidIban', () => {
  it.each(['DE89 3704 0044 0532 0130 00', 'GB82 WEST 1234 5698 7654 32', 'NL91ABNA0417164300', 'FR14 2004 1010 0505 0001 3M02 606'])('accepts %s', (iban) => {
    expect(isValidIban(iban)).toBe(true);
  });

  it.each([
    ['one digit changed', 'DE89 3704 0044 0532 0130 01'],
    ['wrong length for the country', 'DE89 3704 0044 0532 0130 0'],
    ['unknown country', 'XX89 3704 0044 0532 0130 00'],
    ['garbage', 'not an iban'],
  ])('rejects %s', (_, iban) => {
    expect(isValidIban(iban)).toBe(false);
  });

  it('masks all but the country/check digits and the last four', () => {
    expect(maskIban('DE89 3704 0044 0532 0130 00')).toBe('DE89 •••• 3000');
  });
});

describe('isValidVat', () => {
  it('checks German VAT check digits (ISO 7064 MOD 11,10)', () => {
    expect(isValidVat('DE', 'DE136695976')).toBe(true);
    expect(isValidVat('DE', '136695975')).toBe(false);
  });

  it('checks Polish NIP weights', () => {
    expect(isValidVat('PL', 'PL5260250274')).toBe(true);
    expect(isValidVat('PL', '5260250275')).toBe(false);
  });

  it('format-checks countries without a checksum here; Greece uses the EL prefix', () => {
    expect(isValidVat('AT', 'ATU12345678')).toBe(true);
    expect(isValidVat('AT', 'AT12345678')).toBe(false);
    expect(isValidVat('GR', 'EL123456789')).toBe(true);
    expect(isValidVat('ZZ', '123')).toBe(false);
  });
});

describe('namesMatch', () => {
  it('ignores accents, case and legal suffixes', () => {
    expect(namesMatch('Müller Handels GmbH', 'MULLER HANDELS')).toBe(true);
    expect(namesMatch('Acme Trading Ltd.', 'ACME TRADING LIMITED')).toBe(true);
  });

  it('does not match different businesses that share a word', () => {
    expect(namesMatch('Acme Phones GmbH', 'Zeta Phones GmbH')).toBe(false);
    expect(namesMatch('GmbH', 'Ltd')).toBe(false);
  });
});
