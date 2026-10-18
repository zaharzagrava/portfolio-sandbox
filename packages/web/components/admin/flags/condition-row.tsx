'use client';

import { Trash2Icon } from 'lucide-react';
import type { Dispatch } from 'react';
import { FLAG_ATTRIBUTES, FLAG_OPERATORS } from '@marketplace-sandbox/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { DraftAction, DraftCondition } from '@/lib/admin/flags/draft';
import { Field, NativeSelect } from './field';

export const OPERATOR_LABEL: Record<(typeof FLAG_OPERATORS)[number], string> = {
  in: 'is one of',
  not_in: 'is not one of',
  eq: 'equals',
  neq: 'does not equal',
  gte: 'at least',
  lte: 'at most',
  exists: 'is set',
};

/** One condition of a rule (W06 AS-22): attribute and operator from the contracts' closed sets, values shaped by the operator. */
export function ConditionRow({
  condition,
  number,
  ruleUid,
  ruleId,
  base,
  dispatch,
  issues,
}: {
  condition: DraftCondition;
  number: number;
  ruleUid: string;
  ruleId: string;
  /** DOM id prefix, `rule-{i}-condition-{j}`. */
  base: string;
  dispatch: Dispatch<DraftAction>;
  issues: Record<string, string>;
}) {
  const set = (patch: Partial<Pick<DraftCondition, 'attribute' | 'op' | 'valuesText'>>) => dispatch({ type: 'editCondition', ruleUid, uid: condition.uid, patch });
  return (
    <fieldset className="space-y-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">Condition {number}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${base}-attribute`} label="Attribute" error={issues[`${base}-attribute`]}>
          {(props) => (
            <NativeSelect {...props} value={condition.attribute} onChange={(event) => set({ attribute: event.target.value })}>
              {FLAG_ATTRIBUTES.map((attribute) => (
                <option key={attribute} value={attribute}>
                  {attribute}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field id={`${base}-op`} label="Operator" error={issues[`${base}-op`]}>
          {(props) => (
            <NativeSelect {...props} value={condition.op} onChange={(event) => set({ op: event.target.value })}>
              {FLAG_OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {OPERATOR_LABEL[op]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </div>
      {condition.op !== 'exists' && (
        <Field id={`${base}-values`} label="Values" hint={condition.op === 'in' || condition.op === 'not_in' ? 'One value per line.' : undefined} error={issues[`${base}-values`]}>
          {(props) =>
            condition.op === 'in' || condition.op === 'not_in' ? (
              <Textarea {...props} value={condition.valuesText} onChange={(event) => set({ valuesText: event.target.value })} rows={3} spellCheck={false} />
            ) : (
              <Input
                {...props}
                value={condition.valuesText}
                onChange={(event) => set({ valuesText: event.target.value })}
                inputMode={condition.op === 'gte' || condition.op === 'lte' ? 'decimal' : undefined}
                autoComplete="off"
                spellCheck={false}
              />
            )
          }
        </Field>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 sm:min-h-7"
        onClick={() => dispatch({ type: 'removeCondition', ruleUid, uid: condition.uid })}
        aria-label={`Remove condition ${number} of rule ${ruleId}`}
      >
        <Trash2Icon aria-hidden="true" />
        Remove
      </Button>
    </fieldset>
  );
}
