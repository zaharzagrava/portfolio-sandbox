import {
  DEFAULT_RESERVED_ALIASES,
  isReservedAlias,
  isValidAlias,
  parseReservedAliases,
} from './alias-rules';

describe('S37 AS-18: alias rules (also AS-19 reserved words)', () => {
  it.each([
    ['summer-drop', true],
    ['abcd', true],
    ['a'.repeat(32), true],
    ['promo2026', true],
    ['a-b-c-d', true],
    ['abc', false],
    ['a'.repeat(33), false],
    ['Summer', false],
    ['SUMMER-drop', false],
    ['-summer', false],
    ['summer-', false],
    ['sum--mer', false],
    ['sum_mer', false],
    ['sum mer', false],
    ['ünïcode', false],
    ['sum.mer', false],
    ['', false],
  ])('format of %j is valid: %s', (alias, valid) => {
    expect(isValidAlias(alias)).toBe(valid);
  });

  it.each(['admin', 'login', 'status', 'help', 'support', 'checkout'])(
    '%s is reserved',
    (alias) => {
      expect(isReservedAlias(alias, DEFAULT_RESERVED_ALIASES)).toBe(true);
    },
  );

  it('does not reserve near misses', () => {
    expect(isReservedAlias('admins', DEFAULT_RESERVED_ALIASES)).toBe(false);
    expect(isReservedAlias('my-admin', DEFAULT_RESERVED_ALIASES)).toBe(false);
  });

  it('reads the configured list: trimmed, lower-cased, entries shorter than 4 characters ignored, merged with the default', () => {
    const list = parseReservedAliases(' Promo , beta,,ab, shop-now ');
    expect(isReservedAlias('promo', list)).toBe(true);
    expect(isReservedAlias('beta', list)).toBe(true);
    expect(isReservedAlias('shop-now', list)).toBe(true);
    expect(isReservedAlias('admin', list)).toBe(true);
    expect(list.has('ab')).toBe(false);
  });
});
