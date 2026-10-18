'use client';

import { PlusIcon, Trash2Icon } from 'lucide-react';
import type { Dispatch } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { DraftAction, DraftRule } from '@/lib/admin/flags/draft';
import { Field, VariantSelect } from './field';

/** The sum of the weights as the live line reads it: percent, at most two decimals, a bad entry counts as 0. */
export function totalPercent(slices: { percentText: string }[]): string {
  const sum = slices.reduce((total, slice) => total + (Number(slice.percentText) || 0), 0);
  return String(Math.round(sum * 100) / 100);
}

/**
 * The outcome of a rule (W06 AS-23): a fixed variant, or a percentage rollout in percent (the request carries basis points)
 * with a live total. The total is information only: a total other than 100% is sent as typed and the API answers
 * `weights_sum_invalid` at this rule.
 */
export function OutcomeEditor({ rule, base, variants, dispatch, issues }: { rule: DraftRule; base: string; variants: string[]; dispatch: Dispatch<DraftAction>; issues: Record<string, string> }) {
  const { outcome } = rule;
  if (outcome.kind === 'raw') return null;
  const kindName = `${base}-kind-${rule.uid}`;
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label={`Outcome of rule ${rule.id}`} className="flex flex-wrap gap-4 text-sm">
        {(['variant', 'rollout'] as const).map((kind) => (
          <label key={kind} className="flex min-h-11 items-center gap-2 sm:min-h-8">
            <input type="radio" name={kindName} checked={outcome.kind === kind} onChange={() => dispatch({ type: 'setOutcomeKind', ruleUid: rule.uid, kind })} />
            {kind === 'variant' ? 'Fixed variant' : 'Percentage rollout'}
          </label>
        ))}
      </div>
      {outcome.kind === 'variant' ? (
        <Field id={`${base}-outcome`} label="Variant" error={issues[`${base}-outcome`]}>
          {(props) => <VariantSelect {...props} variants={variants} value={outcome.variant} onChange={(value) => dispatch({ type: 'setOutcomeVariant', ruleUid: rule.uid, variant: value })} />}
        </Field>
      ) : (
        <fieldset
          id={`${base}-rollout`}
          tabIndex={-1}
          aria-describedby={issues[`${base}-rollout`] ? `${base}-rollout-error` : undefined}
          aria-invalid={issues[`${base}-rollout`] ? true : undefined}
          className="space-y-3 rounded-lg border p-3"
        >
          <legend className="px-1 text-sm font-medium">Rollout</legend>
          {outcome.slices.map((slice, index) => (
            <div key={slice.uid} className="grid items-end gap-3 sm:grid-cols-[1fr_9rem_auto]">
              <Field id={`${base}-slice-${index}-variant`} label="Variant">
                {(props) => <VariantSelect {...props} variants={variants} value={slice.variant} onChange={(value) => dispatch({ type: 'editSlice', ruleUid: rule.uid, uid: slice.uid, patch: { variant: value } })} />}
              </Field>
              <Field id={`${base}-slice-${index}-weight`} label="Weight (%)">
                {(props) => (
                  <Input {...props} value={slice.percentText} inputMode="decimal" autoComplete="off" onChange={(event) => dispatch({ type: 'editSlice', ruleUid: rule.uid, uid: slice.uid, patch: { percentText: event.target.value } })} />
                )}
              </Field>
              <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" aria-label={`Remove slice ${index + 1} of rule ${rule.id}`} onClick={() => dispatch({ type: 'removeSlice', ruleUid: rule.uid, uid: slice.uid })}>
                <Trash2Icon aria-hidden="true" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => dispatch({ type: 'addSlice', ruleUid: rule.uid })}>
              <PlusIcon aria-hidden="true" />
              Add slice
            </Button>
            <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => dispatch({ type: 'remainder', ruleUid: rule.uid })}>
              Make the last slice the remainder
            </Button>
            <p className="text-sm font-medium">Total: {totalPercent(outcome.slices)}%</p>
          </div>
          <p className="text-xs text-muted-foreground">Raising a percentage only adds visitors; nobody who already has the variant loses it.</p>
          {issues[`${base}-rollout`] && (
            <p id={`${base}-rollout-error`} className="text-sm text-destructive">
              {issues[`${base}-rollout`]}
            </p>
          )}
        </fieldset>
      )}
    </div>
  );
}
