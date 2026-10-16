import * as fc from 'fast-check';
import {
  isValidIban,
  isValidVat,
  maskHolder,
  maskIban,
  maskVat,
  namesMatch,
} from './validators';

describe('isValidIban', () => {
  it.each([
    'DE89 3704 0044 0532 0130 00',
    'GB82 WEST 1234 5698 7654 32',
    'NL91ABNA0417164300',
    'FR14 2004 1010 0505 0001 3M02 606',
  ])('accepts %s', (iban) => {
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

  it("S04 AS-71: a number carrying another EU country's prefix is not valid for this country", () => {
    expect(isValidVat('FR', 'DE136695976')).toBe(false);
    expect(isValidVat('NL', 'DE136695976')).toBe(false);
    expect(isValidVat('DE', 'FR12345678901')).toBe(false);
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

describe('NL VAT', () => {
  it.each([
    ['11-proof number', 'NL004495445B01'],
    ['prefix and separators tolerated', 'nl 0044.95445 B01'],
    ['mod-97 number', 'NL000099998B57'],
  ])('S04 AS-71: accepts %s', (_, vat) => {
    expect(isValidVat('NL', vat)).toBe(true);
  });

  it.each([
    ['checksum off by one', 'NL004495446B01'],
    ['8 digits', 'NL04495445B01'],
    ['missing B', 'NL00449544501'],
    ['letters in the body', 'NL00449544AB01'],
    ['empty', ''],
  ])('S04 AS-71: rejects %s', (_, vat) => {
    expect(isValidVat('NL', vat)).toBe(false);
  });
});

describe('IBAN mod-97 property', () => {
  const COUNTRY_LENGTH: [string, number][] = [
    ['DE', 22],
    ['NL', 18],
    ['FR', 27],
    ['PL', 28],
    ['ES', 24],
  ];
  const mod97 = (digits: string) => BigInt(digits) % 97n;
  const expand = (s: string) =>
    s.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));

  /** A valid IBAN of the country: digits for the body, then the check digits that make the remainder 1. */
  const build = (country: string, length: number, body: string) => {
    const bban = body.slice(0, length - 4);
    const check = 98n - mod97(expand(`${bban}${country}00`));
    return `${country}${check.toString().padStart(2, '0')}${bban}`;
  };

  const ibanArb = fc
    .record({
      cl: fc.constantFrom(...COUNTRY_LENGTH),
      body: fc.stringMatching(/^[0-9]{30}$/),
    })
    .map(({ cl: [country, length], body }) => build(country, length, body));

  it('S04 AS-71: every generated valid IBAN passes', () => {
    fc.assert(
      fc.property(ibanArb, (iban) => isValidIban(iban)),
      { numRuns: 300 },
    );
  });

  it('S04 AS-71: any single-digit change fails', () => {
    fc.assert(
      fc.property(
        ibanArb,
        fc.nat(),
        fc.integer({ min: 1, max: 9 }),
        (iban, at, delta) => {
          const i = 2 + (at % (iban.length - 2));
          const changed =
            iban.slice(0, i) +
            String((Number(iban[i]) + delta) % 10) +
            iban.slice(i + 1);
          return !isValidIban(changed);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('S04 AS-71: accepts exactly the numbers with remainder 1', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[0-9]{18}$/),
        fc.nat({ max: 99 }),
        (body, c) => {
          const iban = `DE${String(c).padStart(2, '0')}${body}`;
          const remainder = mod97(
            expand(`${iban.slice(4)}${iban.slice(0, 4)}`),
          );
          return isValidIban(iban) === (remainder === 1n);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('masking', () => {
  it.each([
    [
      'IBAN keeps the first four and last four',
      () => maskIban('DE89 3704 0044 0532 0130 00'),
      'DE89 •••• 3000',
    ],
    ['IBAN too short', () => maskIban('DE89'), '••••'],
    [
      'VAT keeps prefix and last three',
      () => maskVat('DE136695976'),
      'DE •••• 976',
    ],
    ['VAT without prefix', () => maskVat('136695976'), '•••• 976'],
    ['VAT too short', () => maskVat('DE1'), '••••'],
    [
      'holder keeps initials',
      () => maskHolder('Müller Handels GmbH'),
      'M••• H••• G•••',
    ],
    ['holder empty', () => maskHolder('  '), '••••'],
  ])('S04 AS-71: %s', (_, actual, expected) => {
    expect(actual()).toBe(expected);
  });

  it('S04 AS-71: masked values never contain the middle of the original', () => {
    expect(maskIban('DE89370400440532013000')).not.toContain('0532');
    expect(maskVat('DE136695976')).not.toContain('6669');
    expect(maskHolder('Müller Handels')).not.toContain('ller');
  });
});
