/** Synonym rule grammar (FR-042, AS-54, AS-55, AS-83). Pure: no engine, no persistence. */
export const MAX_SYNONYM_RULES = 5000;
export const MAX_SYNONYM_RULE_LENGTH = 200;

export const SYNONYM_RULE_ERROR_CODES = [
  'too_many',
  'too_long',
  'empty',
  'too_few_terms',
  'empty_side',
  'invalid_character',
  'duplicate',
  'cycle',
] as const;
export type SynonymRuleErrorCode = (typeof SYNONYM_RULE_ERROR_CODES)[number];

export interface SynonymRuleError {
  index: number;
  code: SynonymRuleErrorCode;
}

export type ParsedSynonyms =
  | { ok: true; rules: string[] }
  | { ok: false; errors: SynonymRuleError[] };

/** Letters, digits, spaces, and a few joiners common in product names. */
const TERM_CHARACTERS = /^[\p{L}\p{N} \-_.'/&+]+$/u;

const normaliseTerm = (term: string): string =>
  term.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

type Parsed =
  | { kind: 'one-way'; from: string; to: string; text: string }
  | { kind: 'two-way'; text: string }
  | { code: SynonymRuleErrorCode };

function parseRule(raw: string): Parsed {
  if (raw.length > MAX_SYNONYM_RULE_LENGTH) return { code: 'too_long' };
  if (raw.trim() === '') return { code: 'empty' };

  if (raw.includes('=>')) {
    const sides = raw.split('=>');
    if (sides.length !== 2) return { code: 'invalid_character' };
    const [from, to] = sides.map(normaliseTerm);
    if (from === '' || to === '') return { code: 'empty_side' };
    if (!TERM_CHARACTERS.test(from) || !TERM_CHARACTERS.test(to))
      return { code: 'invalid_character' };
    return { kind: 'one-way', from, to, text: `${from} => ${to}` };
  }

  const terms = raw.split(',').map(normaliseTerm).filter((t) => t !== '');
  if (!terms.every((t) => TERM_CHARACTERS.test(t)))
    return { code: 'invalid_character' };
  const unique = [...new Set(terms)].sort();
  if (unique.length < 2) return { code: 'too_few_terms' };
  return { kind: 'two-way', text: unique.join(', ') };
}

/** Rule indexes whose edge lies on a directed cycle (including self-loops) of the one-way graph. */
function cycleMembers(edges: { index: number; from: string; to: string }[]) {
  const adjacency = new Map<string, string[]>();
  for (const e of edges)
    adjacency.set(e.from, [...(adjacency.get(e.from) ?? []), e.to]);

  const reaches = (start: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const node = stack.pop() as string;
      if (node === target) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      stack.push(...(adjacency.get(node) ?? []));
    }
    return false;
  };
  // An edge a -> b is on a cycle iff b reaches a.
  return new Set(edges.filter((e) => reaches(e.to, e.from)).map((e) => e.index));
}

export function parseSynonymRules(input: readonly string[]): ParsedSynonyms {
  if (input.length > MAX_SYNONYM_RULES)
    return {
      ok: false,
      errors: [{ index: MAX_SYNONYM_RULES, code: 'too_many' }],
    };

  const errors: SynonymRuleError[] = [];
  const rules: string[] = [];
  const seen = new Set<string>();
  const edges: { index: number; from: string; to: string }[] = [];

  input.forEach((raw, index) => {
    const parsed = parseRule(raw);
    if ('code' in parsed) {
      errors.push({ index, code: parsed.code });
      return;
    }
    if (seen.has(parsed.text)) {
      errors.push({ index, code: 'duplicate' });
      return;
    }
    seen.add(parsed.text);
    rules.push(parsed.text);
    if (parsed.kind === 'one-way')
      edges.push({ index, from: parsed.from, to: parsed.to });
  });

  for (const index of cycleMembers(edges)) errors.push({ index, code: 'cycle' });
  if (errors.length)
    return { ok: false, errors: errors.sort((a, b) => a.index - b.index) };
  return { ok: true, rules };
}
