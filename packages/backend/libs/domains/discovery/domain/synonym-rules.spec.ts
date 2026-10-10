import {
  MAX_SYNONYM_RULES,
  MAX_SYNONYM_RULE_LENGTH,
  parseSynonymRules,
  type SynonymRuleErrorCode,
} from './synonym-rules';

const rulesOf = (input: string[]) => {
  const result = parseSynonymRules(input);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.rules;
};
const errorsOf = (input: string[]) => {
  const result = parseSynonymRules(input);
  if (result.ok) throw new Error('expected errors');
  return result.errors;
};

describe('synonym rule grammar (S32 AS-83, AS-54, AS-55)', () => {
  it('S32 AS-54: accepts one-way, two-way and multi-word rules', () => {
    expect(
      rulesOf(['tv => television', 'sneakers, trainers', 'usb c, usb-c, type c']),
    ).toEqual(['tv => television', 'sneakers, trainers', 'type c, usb c, usb-c']);
  });

  it.each([
    ['  TV   =>   Television ', 'tv => television'],
    ['Trainers,Sneakers', 'sneakers, trainers'],
    ['b, a, c', 'a, b, c'],
    ['usb  c => usb-c', 'usb c => usb-c'],
    ['a, a, b', 'a, b'],
    ['Éclair, eclair', 'eclair, éclair'],
  ])('S32 AS-83: normalises %j to %j', (input, expected) => {
    expect(rulesOf([input])).toEqual([expected]);
  });

  it('S32 AS-83: an empty list is valid', () => {
    expect(rulesOf([])).toEqual([]);
  });

  it.each<[string, string, SynonymRuleErrorCode]>([
    ['empty', '', 'empty'],
    ['blank', '   ', 'empty'],
    ['one term', 'laptop', 'too_few_terms'],
    ['comma rule with one term', 'laptop,', 'too_few_terms'],
    ['comma only', ',', 'too_few_terms'],
    ['same term twice', 'a, a', 'too_few_terms'],
    ['empty left side', ' => b', 'empty_side'],
    ['empty right side', 'a =>', 'empty_side'],
    ['both sides empty', '=>', 'empty_side'],
    ['bad character', 'a! , b', 'invalid_character'],
    ['control character', 'a\u0000, b', 'invalid_character'],
    ['two arrows', 'a => b => c', 'invalid_character'],
    ['comma in one-way', 'a, b => c', 'invalid_character'],
    ['too long', `${'a'.repeat(MAX_SYNONYM_RULE_LENGTH)}, b`, 'too_long'],
  ])('S32 AS-55: %s -> %s', (_n, rule, code) => {
    expect(errorsOf([rule])).toEqual([{ index: 0, code }]);
  });

  it('S32 AS-55: a rule of exactly 200 characters is accepted', () => {
    const rule = `${'a'.repeat(197)}, b`;
    expect(rule).toHaveLength(MAX_SYNONYM_RULE_LENGTH);
    expect(rulesOf([rule])).toHaveLength(1);
  });

  it('S32 AS-55: reports the index of each bad rule and keeps validating the rest', () => {
    expect(errorsOf(['tv => television', '', 'ok, fine', 'a =>'])).toEqual([
      { index: 1, code: 'empty' },
      { index: 3, code: 'empty_side' },
    ]);
  });

  it('S32 AS-55: duplicates are flagged on the later rule, also after normalisation', () => {
    expect(errorsOf(['a, b', 'x => y', 'B,  A', 'X=>y'])).toEqual([
      { index: 2, code: 'duplicate' },
      { index: 3, code: 'duplicate' },
    ]);
  });

  it('S32 AS-55: one-way cycles are flagged on every rule of the cycle', () => {
    expect(errorsOf(['a => b', 'b => a'])).toEqual([
      { index: 0, code: 'cycle' },
      { index: 1, code: 'cycle' },
    ]);
    expect(errorsOf(['a => b', 'z => q', 'b => c', 'c => a'])).toEqual([
      { index: 0, code: 'cycle' },
      { index: 2, code: 'cycle' },
      { index: 3, code: 'cycle' },
    ]);
    expect(errorsOf(['a => a'])).toEqual([{ index: 0, code: 'cycle' }]);
  });

  it('S32 AS-55: chains and two-way rules are not cycles', () => {
    expect(rulesOf(['a => b', 'b => c', 'a, b'])).toHaveLength(3);
    expect(rulesOf(['a => b', 'b, a2'])).toHaveLength(2);
  });

  it('S32 AS-55: allows exactly 5000 rules and rejects 5001 with too_many', () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `x${i}, y${i}`);
    expect(rulesOf(make(MAX_SYNONYM_RULES))).toHaveLength(5000);
    expect(errorsOf(make(MAX_SYNONYM_RULES + 1))).toEqual([
      { index: MAX_SYNONYM_RULES, code: 'too_many' },
    ]);
  });
});
