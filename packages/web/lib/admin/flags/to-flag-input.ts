import type { FlagInput, FlagValue } from '@marketplace-sandbox/contracts';
import type { Draft, DraftCondition, DraftRule, DraftVariant } from './draft';

/** A syntax problem the editor catches before sending (W06 AS-30): the DOM id of the field and what to tell the admin. */
export type FieldIssue = { fieldId: string; message: string };

const PERCENT = /^\d+(?:\.\d{1,2})?$/;

function valueOf(variant: DraftVariant, index: number, issues: FieldIssue[]): FlagValue {
  const fieldId = `variant-${index}-value`;
  switch (variant.type) {
    case 'boolean':
      return variant.text === 'true';
    case 'string':
      return variant.text;
    case 'number': {
      const number = Number(variant.text);
      if (variant.text.trim() === '' || !Number.isFinite(number)) {
        issues.push({ fieldId, message: 'Enter a number.' });
        return 0;
      }
      return number;
    }
    default:
      try {
        return JSON.parse(variant.text) as FlagValue;
      } catch {
        issues.push({ fieldId, message: 'Enter valid JSON.' });
        return {};
      }
  }
}

function conditionValues(condition: DraftCondition, fieldId: string, issues: FieldIssue[]): (string | number | boolean)[] {
  if (condition.op === 'exists') return [];
  const lines = condition.valuesText.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  // Unedited values keep the type the server stored (a number or boolean in an `in` list stays one).
  if (condition.original && condition.original.map(String).join('\n') === lines.join('\n')) return condition.original;
  if (condition.op === 'gte' || condition.op === 'lte') {
    const first = lines[0];
    const number = Number(first);
    if (first === undefined || !Number.isFinite(number)) {
      issues.push({ fieldId, message: 'Enter a number.' });
      return [];
    }
    return [number];
  }
  if (condition.op === 'eq' || condition.op === 'neq') return lines.slice(0, 1);
  return lines;
}

function ruleOf(rule: DraftRule, index: number, issues: FieldIssue[]): unknown {
  if (rule.outcome.kind === 'raw') return rule.outcome.rule;
  const conditions = rule.conditions.map((condition, at) => ({
    attribute: condition.attribute,
    op: condition.op,
    values: conditionValues(condition, `rule-${index}-condition-${at}-values`, issues),
  }));
  if (rule.outcome.kind === 'variant') return { id: rule.id, conditions, variant: rule.outcome.variant };
  const rollout = rule.outcome.slices.map((slice) => {
    const text = slice.percentText.trim();
    if (!PERCENT.test(text)) {
      issues.push({ fieldId: `rule-${index}-rollout`, message: 'Enter a percentage with at most two decimals.' });
      return { variant: slice.variant, weight: 0 };
    }
    return { variant: slice.variant, weight: Math.round(Number(text) * 100) };
  });
  return { id: rule.id, conditions, rollout };
}

/**
 * The request body of a save or create (W06 FR-020): percent → integer basis points, one value per line → array, `rollout`
 * xor `variant` per rule, an empty expiry → `null`, an empty description omitted, `expectedVersion` = the version the draft
 * was loaded from. Only syntax is checked here (AS-30); every rule about the definition is the API's (VI.9).
 */
export function toFlagInput(draft: Draft): { input: FlagInput | null; errors: FieldIssue[] } {
  const errors: FieldIssue[] = [];
  const variants = draft.variants.map((variant, index) => ({ key: variant.key, value: valueOf(variant, index, errors) }));
  const rules = draft.rules.map((rule, index) => ruleOf(rule, index, errors)) as FlagInput['rules'];
  if (errors.length > 0) return { input: null, errors };
  return {
    errors,
    input: {
      expectedVersion: draft.basisVersion,
      ...(draft.description.trim() === '' ? {} : { description: draft.description }),
      owner: draft.owner,
      enabled: draft.enabled,
      variants,
      defaultVariant: draft.defaultVariant,
      offVariant: draft.offVariant,
      rules,
      bucketBy: draft.bucketBy,
      clientSide: draft.clientSide,
      expiresAt: draft.expiresAt.trim() === '' ? null : new Date(`${draft.expiresAt}:00Z`).toISOString(),
    },
  };
}
