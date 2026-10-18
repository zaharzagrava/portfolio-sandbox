import { formatUtc } from './format-time';

/** One field of an audit entry as readable text (W06 AS-41). `detail*` is the full before/after text of a rule or variant list. */
export type DiffLine = { field: string; label: string; text: string; before?: string; after?: string; detailBefore?: string; detailAfter?: string };
export type FlagDiff = { kind: 'created' | 'changed' | 'none'; lines: DiffLine[] };

type Snapshot = Record<string, unknown>;
type Cond = { attribute?: unknown; op?: unknown; values?: unknown };
type Rule = { id?: unknown; conditions?: unknown; variant?: unknown; rollout?: unknown };

const STATUS: Record<string, string> = { enabled: 'Enabled', disabled: 'Disabled', killed: 'Killed', archived: 'Archived' };
const OPS: Record<string, string> = { in: 'is one of', not_in: 'is not one of', eq: 'equals', neq: 'does not equal', gte: 'is at least', lte: 'is at most', exists: 'is set' };

const text = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function ruleText(rule: Rule): string {
  const conditions = arr(rule.conditions)
    .map((c) => {
      const cond = c as Cond;
      const op = OPS[text(cond.op)] ?? text(cond.op);
      const values = arr(cond.values).map(text).join(', ');
      return `${text(cond.attribute)} ${op}${values ? ` ${values}` : ''}`;
    })
    .join(' and ');
  const outcome = Array.isArray(rule.rollout)
    ? rule.rollout.map((slice) => `${Math.round(Number((slice as { weight?: unknown }).weight ?? 0)) / 100}% ${text((slice as { variant?: unknown }).variant)}`).join(', ')
    : text(rule.variant);
  return `Rule ${text(rule.id)}: ${conditions || 'everyone'} → ${outcome}`;
}
const rulesDetail = (value: unknown) => arr(value).map((rule) => ruleText(rule as Rule)).join('\n');
const variantsDetail = (value: unknown) => arr(value).map((v) => `${text((v as { key?: unknown }).key)} = ${text((v as { value?: unknown }).value)}`).join('\n');

type Field = { field: string; label: string; show: (snapshot: Snapshot) => string; detail?: (snapshot: Snapshot) => string };

const FIELDS: Field[] = [
  { field: 'status', label: 'Status', show: (s) => STATUS[text(s.status)] ?? text(s.status) },
  { field: 'description', label: 'Description', show: (s) => text(s.description) },
  { field: 'owner', label: 'Owner', show: (s) => text(s.owner) },
  { field: 'variants', label: 'Variants', show: (s) => plural(arr(s.variants).length, 'variant'), detail: (s) => variantsDetail(s.variants) },
  { field: 'defaultVariant', label: 'Default variant', show: (s) => text(s.defaultVariant) },
  { field: 'offVariant', label: 'Off variant', show: (s) => text(s.offVariant) },
  { field: 'bucketBy', label: 'Bucket by', show: (s) => text(s.bucketBy) },
  { field: 'rules', label: 'Rules', show: (s) => (arr(s.rules).length === 0 ? 'no rules' : plural(arr(s.rules).length, 'rule')), detail: (s) => rulesDetail(s.rules) },
  { field: 'clientSide', label: 'Client-side', show: (s) => (s.clientSide ? 'Yes' : 'No') },
  { field: 'expiresAt', label: 'Expires', show: (s) => formatUtc(typeof s.expiresAt === 'string' ? s.expiresAt : null) },
];

/**
 * The readable difference between the `before` and `after` of an audit entry (W06 FR-040), computed in the browser from the
 * entry alone. Every value is returned as plain text; the components render it as text, never as markup (VI.7).
 */
export function diffFlags(before: Snapshot | null | undefined, after: Snapshot): FlagDiff {
  if (!before) {
    return { kind: 'created', lines: FIELDS.map((f) => ({ field: f.field, label: f.label, text: `${f.label}: ${f.show(after)}`, after: f.show(after), ...(f.detail ? { detailAfter: f.detail(after) } : {}) })) };
  }
  const lines: DiffLine[] = [];
  for (const f of FIELDS) {
    const [was, now] = [f.show(before), f.show(after)];
    const [detailWas, detailNow] = [f.detail?.(before), f.detail?.(after)];
    if (was === now && detailWas === detailNow) continue;
    const edited = was === now;
    lines.push({
      field: f.field,
      label: f.label,
      before: was,
      after: now,
      text: `${f.label}: ${was} → ${now}${edited ? ' (edited)' : ''}`,
      ...(f.detail ? { detailBefore: detailWas, detailAfter: detailNow } : {}),
    });
  }
  return { kind: lines.length ? 'changed' : 'none', lines };
}
