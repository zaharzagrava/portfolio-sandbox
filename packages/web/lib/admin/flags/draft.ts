import { FLAG_ATTRIBUTES, FLAG_OPERATORS, type Flag, type FlagValue } from '@marketplace-sandbox/contracts';

/**
 * The editor's local state (W06 data-model, R-05): a plain-text mirror of a flag the admin edits, with draft-local `uid`s as
 * React keys for entries that may not exist on the server yet. `toDraft` and `toFlagInput` (to-flag-input.ts) are the pure
 * conversions; `draftReducer` is the only way the draft changes. A refetch never touches it: only `reset` does (FR-021).
 */
export type VariantType = 'boolean' | 'string' | 'number' | 'json';
export type DraftVariant = { uid: string; key: string; type: VariantType; text: string };
export type DraftCondition = { uid: string; attribute: string; op: string; valuesText: string; original?: (string | number | boolean)[] };
export type DraftSlice = { uid: string; variant: string; percentText: string };
export type DraftOutcome =
  | { kind: 'variant'; variant: string }
  | { kind: 'rollout'; slices: DraftSlice[] }
  /** A rule with a feature this editor cannot show: kept as received, read-only, sent back unchanged. */
  | { kind: 'raw'; rule: unknown };
export type DraftRule = { uid: string; id: string; conditions: DraftCondition[]; outcome: DraftOutcome };

/** What a flag looks like to the draft: a `Flag`, or the starter before it exists (`version` 0). */
export type DraftSource = Omit<Flag, 'createdAt' | 'updatedAt' | 'version'> & { version: number };

export type Draft = {
  basisVersion: number;
  status: Flag['status'];
  key: string;
  description: string;
  owner: string;
  enabled: boolean;
  clientSide: boolean;
  /** UTC "YYYY-MM-DDTHH:mm" (the value of a `datetime-local` input read as UTC), or empty. */
  expiresAt: string;
  bucketBy: string;
  defaultVariant: string;
  offVariant: string;
  variants: DraftVariant[];
  rules: DraftRule[];
  /** Snapshot of the loaded state (see `snapshot`): dirty means different from this. */
  baseline: string;
};

let counter = 0;
export const newUid = (): string => `u${(counter += 1)}`;

const inSet = (set: readonly string[], value: unknown) => typeof value === 'string' && set.includes(value);

function variantOf(variant: { key: string; value: FlagValue }): DraftVariant {
  const { key, value } = variant;
  if (typeof value === 'boolean') return { uid: newUid(), key, type: 'boolean', text: String(value) };
  if (typeof value === 'number') return { uid: newUid(), key, type: 'number', text: String(value) };
  if (typeof value === 'string') return { uid: newUid(), key, type: 'string', text: value };
  return { uid: newUid(), key, type: 'json', text: JSON.stringify(value, null, 2) };
}

const percentOf = (basisPoints: number): string => String(Math.round(basisPoints) / 100);

function ruleOf(rule: Flag['rules'][number]): DraftRule {
  const known = rule.conditions.every((c) => inSet(FLAG_ATTRIBUTES, c.attribute) && inSet(FLAG_OPERATORS, c.op));
  const base = { uid: newUid(), id: rule.id };
  if (!known) return { ...base, conditions: [], outcome: { kind: 'raw', rule } };
  return {
    ...base,
    conditions: rule.conditions.map((c) => ({
      uid: newUid(),
      attribute: c.attribute,
      op: c.op,
      valuesText: (c.values ?? []).map(String).join('\n'),
      original: c.values ?? [],
    })),
    outcome: rule.rollout
      ? { kind: 'rollout', slices: rule.rollout.map((slice) => ({ uid: newUid(), variant: slice.variant, percentText: percentOf(slice.weight) })) }
      : { kind: 'variant', variant: rule.variant ?? '' },
  };
}

const toLocalInput = (iso: string | null): string => {
  if (!iso) return '';
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? '' : time.toISOString().slice(0, 16);
};

/** Everything the admin can change, without `uid`s: two drafts with the same snapshot are the same definition. */
export function snapshot(draft: Omit<Draft, 'baseline'> | Draft): string {
  return JSON.stringify({
    description: draft.description,
    owner: draft.owner,
    enabled: draft.enabled,
    clientSide: draft.clientSide,
    expiresAt: draft.expiresAt,
    bucketBy: draft.bucketBy,
    defaultVariant: draft.defaultVariant,
    offVariant: draft.offVariant,
    variants: draft.variants.map(({ key, type, text }) => [key, type, text]),
    rules: draft.rules.map((rule) => [
      rule.id,
      rule.conditions.map((c) => [c.attribute, c.op, c.valuesText]),
      rule.outcome.kind === 'variant' ? ['variant', rule.outcome.variant] : rule.outcome.kind === 'rollout' ? ['rollout', rule.outcome.slices.map((s) => [s.variant, s.percentText])] : ['raw', rule.outcome.rule],
    ]),
  });
}

export function toDraft(flag: DraftSource): Draft {
  const draft = {
    basisVersion: flag.version,
    status: flag.status,
    key: flag.key,
    description: flag.description,
    owner: flag.owner,
    // A killed or archived flag is edited and saved as not enabled (the API refuses to enable a killed one).
    enabled: flag.status === 'enabled',
    clientSide: flag.clientSide,
    expiresAt: toLocalInput(flag.expiresAt),
    bucketBy: flag.bucketBy,
    defaultVariant: flag.defaultVariant,
    offVariant: flag.offVariant,
    variants: flag.variants.map(variantOf),
    rules: flag.rules.map(ruleOf),
  };
  return { ...draft, baseline: snapshot(draft) };
}

export const isDirty = (draft: Draft): boolean => snapshot(draft) !== draft.baseline;

export type DraftAction =
  | { type: 'reset'; flag: DraftSource }
  | { type: 'edit'; patch: Partial<Pick<Draft, 'description' | 'owner' | 'enabled' | 'clientSide' | 'expiresAt' | 'bucketBy' | 'defaultVariant' | 'offVariant' | 'key'>> }
  | { type: 'addVariant' }
  | { type: 'editVariant'; uid: string; patch: Partial<Pick<DraftVariant, 'key' | 'type' | 'text'>> }
  | { type: 'removeVariant'; uid: string }
  | { type: 'addRule' }
  | { type: 'removeRule'; uid: string }
  | { type: 'moveRule'; uid: string; direction: -1 | 1 }
  | { type: 'editRule'; uid: string; patch: { id: string } }
  | { type: 'setOutcomeKind'; ruleUid: string; kind: 'variant' | 'rollout' }
  | { type: 'setOutcomeVariant'; ruleUid: string; variant: string }
  | { type: 'addSlice'; ruleUid: string }
  | { type: 'editSlice'; ruleUid: string; uid: string; patch: Partial<Pick<DraftSlice, 'variant' | 'percentText'>> }
  | { type: 'removeSlice'; ruleUid: string; uid: string }
  | { type: 'remainder'; ruleUid: string }
  | { type: 'addCondition'; ruleUid: string }
  | { type: 'editCondition'; ruleUid: string; uid: string; patch: Partial<Pick<DraftCondition, 'attribute' | 'op' | 'valuesText'>> }
  | { type: 'removeCondition'; ruleUid: string; uid: string };

const SINGLE = new Set(['eq', 'neq', 'gte', 'lte']);

/** What survives an operator change: lists keep their lines, single-value operators the first line, `exists` nothing. */
function valuesFor(op: string, text: string): string {
  if (op === 'exists') return '';
  return SINGLE.has(op) ? (text.split('\n')[0] ?? '') : text;
}

const uniqueName = (prefix: string, taken: string[]): string => {
  let n = 1;
  while (taken.includes(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
};

const mapRule = (draft: Draft, uid: string, change: (rule: DraftRule) => DraftRule): Draft => ({
  ...draft,
  rules: draft.rules.map((rule) => (rule.uid === uid ? change(rule) : rule)),
});

function slicesOf(rule: DraftRule): DraftSlice[] | null {
  return rule.outcome.kind === 'rollout' ? rule.outcome.slices : null;
}

export function draftReducer(draft: Draft, action: DraftAction): Draft {
  switch (action.type) {
    case 'reset':
      return toDraft(action.flag);
    case 'edit':
      return { ...draft, ...action.patch };
    case 'addVariant':
      return { ...draft, variants: [...draft.variants, { uid: newUid(), key: uniqueName('variant', draft.variants.map((v) => v.key)), type: 'string', text: '' }] };
    case 'editVariant': {
      const current = draft.variants.find((variant) => variant.uid === action.uid);
      if (!current) return draft;
      const next = { ...current, ...action.patch };
      if (action.patch.key !== undefined && action.patch.key !== current.key) {
        // Renaming keeps the choices that pointed at the old key.
        const rename = (value: string) => (value === current.key ? next.key : value);
        return {
          ...draft,
          defaultVariant: rename(draft.defaultVariant),
          offVariant: rename(draft.offVariant),
          variants: draft.variants.map((variant) => (variant.uid === action.uid ? next : variant)),
          rules: draft.rules.map((rule) =>
            rule.outcome.kind === 'variant'
              ? { ...rule, outcome: { kind: 'variant', variant: rename(rule.outcome.variant) } }
              : rule.outcome.kind === 'rollout'
                ? { ...rule, outcome: { kind: 'rollout', slices: rule.outcome.slices.map((slice) => ({ ...slice, variant: rename(slice.variant) })) } }
                : rule,
          ),
        };
      }
      return { ...draft, variants: draft.variants.map((variant) => (variant.uid === action.uid ? next : variant)) };
    }
    case 'removeVariant': {
      const removed = draft.variants.find((variant) => variant.uid === action.uid);
      if (!removed) return draft;
      const clear = (value: string) => (value === removed.key ? '' : value);
      return {
        ...draft,
        variants: draft.variants.filter((variant) => variant.uid !== action.uid),
        defaultVariant: clear(draft.defaultVariant),
        offVariant: clear(draft.offVariant),
        rules: draft.rules.map((rule) =>
          rule.outcome.kind === 'variant'
            ? { ...rule, outcome: { kind: 'variant', variant: clear(rule.outcome.variant) } }
            : rule.outcome.kind === 'rollout'
              ? { ...rule, outcome: { kind: 'rollout', slices: rule.outcome.slices.map((slice) => ({ ...slice, variant: clear(slice.variant) })) } }
              : rule,
        ),
      };
    }
    case 'addRule':
      return {
        ...draft,
        rules: [
          ...draft.rules,
          { uid: newUid(), id: uniqueName('rule', draft.rules.map((rule) => rule.id)), conditions: [], outcome: { kind: 'variant', variant: draft.variants[0]?.key ?? '' } },
        ],
      };
    case 'removeRule':
      return { ...draft, rules: draft.rules.filter((rule) => rule.uid !== action.uid) };
    case 'moveRule': {
      const from = draft.rules.findIndex((rule) => rule.uid === action.uid);
      const to = from + action.direction;
      if (from < 0 || to < 0 || to >= draft.rules.length) return draft;
      const rules = [...draft.rules];
      [rules[from], rules[to]] = [rules[to]!, rules[from]!];
      return { ...draft, rules };
    }
    case 'editRule':
      return mapRule(draft, action.uid, (rule) => ({ ...rule, id: action.patch.id }));
    case 'setOutcomeKind':
      return mapRule(draft, action.ruleUid, (rule) => {
        if (rule.outcome.kind === action.kind || rule.outcome.kind === 'raw') return rule;
        const first = draft.variants[0]?.key ?? '';
        if (action.kind === 'rollout') return { ...rule, outcome: { kind: 'rollout', slices: [{ uid: newUid(), variant: first, percentText: '100' }] } };
        const carried = rule.outcome.kind === 'rollout' ? rule.outcome.slices[0]?.variant : undefined;
        return { ...rule, outcome: { kind: 'variant', variant: carried ?? first } };
      });
    case 'setOutcomeVariant':
      return mapRule(draft, action.ruleUid, (rule) => (rule.outcome.kind === 'variant' ? { ...rule, outcome: { kind: 'variant', variant: action.variant } } : rule));
    case 'addSlice':
      return mapRule(draft, action.ruleUid, (rule) => {
        const slices = slicesOf(rule);
        if (!slices) return rule;
        const used = slices.map((slice) => slice.variant);
        const variant = draft.variants.find((candidate) => !used.includes(candidate.key))?.key ?? '';
        return { ...rule, outcome: { kind: 'rollout', slices: [...slices, { uid: newUid(), variant, percentText: '0' }] } };
      });
    case 'editSlice':
      return mapRule(draft, action.ruleUid, (rule) => {
        const slices = slicesOf(rule);
        return slices ? { ...rule, outcome: { kind: 'rollout', slices: slices.map((slice) => (slice.uid === action.uid ? { ...slice, ...action.patch } : slice)) } } : rule;
      });
    case 'removeSlice':
      return mapRule(draft, action.ruleUid, (rule) => {
        const slices = slicesOf(rule);
        return slices ? { ...rule, outcome: { kind: 'rollout', slices: slices.filter((slice) => slice.uid !== action.uid) } } : rule;
      });
    case 'remainder':
      return mapRule(draft, action.ruleUid, (rule) => {
        const slices = slicesOf(rule);
        if (!slices || slices.length === 0) return rule;
        const others = slices.slice(0, -1).reduce((sum, slice) => sum + (Number(slice.percentText) || 0), 0);
        const rest = Math.max(0, Math.round((100 - others) * 100) / 100);
        return { ...rule, outcome: { kind: 'rollout', slices: slices.map((slice, index) => (index === slices.length - 1 ? { ...slice, percentText: String(rest) } : slice)) } };
      });
    case 'addCondition':
      return mapRule(draft, action.ruleUid, (rule) => ({
        ...rule,
        conditions: [...rule.conditions, { uid: newUid(), attribute: FLAG_ATTRIBUTES[0], op: 'in', valuesText: '' }],
      }));
    case 'editCondition':
      return mapRule(draft, action.ruleUid, (rule) => ({
        ...rule,
        conditions: rule.conditions.map((condition) => {
          if (condition.uid !== action.uid) return condition;
          const op = action.patch.op ?? condition.op;
          const valuesText = valuesFor(op, action.patch.valuesText ?? condition.valuesText);
          return { ...condition, ...action.patch, op, valuesText };
        }),
      }));
    case 'removeCondition':
      return mapRule(draft, action.ruleUid, (rule) => ({ ...rule, conditions: rule.conditions.filter((condition) => condition.uid !== action.uid) }));
    default:
      return draft;
  }
}
