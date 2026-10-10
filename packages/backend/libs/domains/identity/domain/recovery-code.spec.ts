import * as fc from 'fast-check';
import {
  RECOVERY_ALPHABET,
  RECOVERY_CODE_COUNT,
  formatRecoveryCode,
  generateRecoveryCodes,
  normaliseRecoveryCode,
} from './recovery-code';

const FORMAT = /^[A-Z2-9]{5}-[A-Z2-9]{5}$/;

describe('S02 AS-11: recovery codes', () => {
  it('uses the fixed 31-symbol alphabet without look-alikes', () => {
    expect(RECOVERY_ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ23456789');
    for (const bad of ['0', 'O', '1', 'I', 'L'])
      expect(RECOVERY_ALPHABET).not.toContain(bad);
  });

  it('generates ten codes of the form XXXXX-XXXXX', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const code of codes) expect(code).toMatch(FORMAT);
  });

  it('formats ten symbols with a hyphen after the fifth', () => {
    expect(formatRecoveryCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
  });

  it.each([
    ['ABCDE-FGHJK', 'ABCDEFGHJK'],
    ['abcde-fghjk', 'ABCDEFGHJK'],
    ['abcdefghjk', 'ABCDEFGHJK'],
    ['  ABCDE-FGHJK\n', 'ABCDEFGHJK'],
  ])('normalises %j to %j', (input, expected) => {
    expect(normaliseRecoveryCode(input)).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['too short', 'ABCDE-FGHJ'],
    ['too long', 'ABCDE-FGHJKM'],
    ['hyphen in the wrong place', 'ABCD-EFGHJK'],
    ['two hyphens', 'ABCDE--FGHJK'],
    ['space inside', 'ABCDE FGHJK'],
    ['look-alike symbol', 'ABCDE-FGHJ0'],
    ['unicode', 'ABCDE-FGHJ٣'],
  ])('rejects %s', (_name, input) => {
    expect(normaliseRecoveryCode(input)).toBeNull();
  });

  it('property: the codes of a set are unique and only use the alphabet', () => {
    fc.assert(
      fc.property(fc.constant(0), () => {
        const codes = generateRecoveryCodes();
        expect(new Set(codes).size).toBe(codes.length);
        for (const code of codes)
          for (const ch of code.replace('-', ''))
            expect(RECOVERY_ALPHABET).toContain(ch);
      }),
      { numRuns: 200 },
    );
  });
});
