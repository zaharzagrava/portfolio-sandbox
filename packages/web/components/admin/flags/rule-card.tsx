'use client';

import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useState, useSyncExternalStore, type Dispatch } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { DraftAction, DraftRule } from '@/lib/admin/flags/draft';
import { ConditionRow } from './condition-row';
import { Field } from './field';
import { OutcomeEditor } from './outcome-editor';

const PHONE = '(max-width: 640px)';
const subscribePhone = (notify: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};
const isPhone = () => window.matchMedia(PHONE).matches;

function summaryOf(rule: DraftRule): string {
  const conditions = rule.conditions.length === 1 ? '1 condition' : `${rule.conditions.length} conditions`;
  const outcome =
    rule.outcome.kind === 'variant' ? `serves ${rule.outcome.variant || '(no variant)'}` : rule.outcome.kind === 'rollout' ? `rollout of ${rule.outcome.slices.length} ${rule.outcome.slices.length === 1 ? 'slice' : 'slices'}` : 'unsupported rule';
  return `${rule.id || 'unnamed'}, ${rule.outcome.kind === 'raw' ? 'read-only' : conditions}, ${outcome}`;
}

/**
 * One rule (W06 AS-21, AS-61): a `fieldset` named "Rule {n}" whose body is a disclosure ("Rule {n}: {summary}"), with the move
 * and remove buttons always reachable in its header. A flag with up to three rules starts expanded; with more, a phone starts
 * collapsed.
 */
export function RuleCard({
  rule,
  index,
  count,
  variants,
  dispatch,
  issues,
  readOnly,
  onMove,
}: {
  rule: DraftRule;
  index: number;
  count: number;
  variants: string[];
  dispatch: Dispatch<DraftAction>;
  issues: Record<string, string>;
  readOnly: boolean;
  onMove: (uid: string, direction: -1 | 1) => void;
}) {
  const number = index + 1;
  const base = `rule-${index}`;
  // Until the admin toggles it, a rule is open unless the flag has many rules and the screen is a phone (AS-61).
  const phone = useSyncExternalStore(subscribePhone, isPhone, () => false);
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? !(phone && count > 3);

  const first = index === 0;
  const last = index === count - 1;
  const body = `${base}-body`;
  return (
    <fieldset id={base} tabIndex={-1} disabled={readOnly} className="space-y-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-semibold">Rule {number}</legend>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={body}
          onClick={() => setToggled(!open)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:min-h-8"
        >
          {open ? <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0" /> : <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0" />}
          <span className="min-w-0 break-words">
            Rule {number}: {summaryOf(rule)}
          </span>
        </button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8"
          aria-label={`Move rule ${number} up`}
          aria-disabled={first || undefined}
          data-rule-uid={rule.uid}
          data-move="up"
          onClick={() => !first && onMove(rule.uid, -1)}
        >
          <ChevronUpIcon aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8"
          aria-label={`Move rule ${number} down`}
          aria-disabled={last || undefined}
          data-rule-uid={rule.uid}
          data-move="down"
          onClick={() => !last && onMove(rule.uid, 1)}
        >
          <ChevronDownIcon aria-hidden="true" />
        </Button>
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" aria-label={`Remove rule ${number}`} onClick={() => dispatch({ type: 'removeRule', uid: rule.uid })}>
          <Trash2Icon aria-hidden="true" />
          Remove
        </Button>
      </div>
      <div id={body} hidden={!open} className="space-y-3">
        {rule.outcome.kind === 'raw' ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">This rule uses a feature this editor can&apos;t show yet. Edit is disabled for it.</p>
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs break-words whitespace-pre-wrap">{JSON.stringify(rule.outcome.rule, null, 2)}</pre>
          </div>
        ) : (
          <>
            <Field id={`${base}-id`} label="Id" error={issues[`${base}-id`]}>
              {(props) => <Input {...props} value={rule.id} onChange={(event) => dispatch({ type: 'editRule', uid: rule.uid, patch: { id: event.target.value } })} maxLength={32} autoComplete="off" spellCheck={false} className="font-mono" />}
            </Field>
            <div className="space-y-3">
              {rule.conditions.length === 0 && <p className="text-sm text-muted-foreground">No conditions: the rule matches everyone.</p>}
              {rule.conditions.map((condition, at) => (
                <ConditionRow key={condition.uid} condition={condition} number={at + 1} ruleUid={rule.uid} ruleId={rule.id} base={`${base}-condition-${at}`} dispatch={dispatch} issues={issues} />
              ))}
              <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => dispatch({ type: 'addCondition', ruleUid: rule.uid })}>
                <PlusIcon aria-hidden="true" />
                Add condition
              </Button>
            </div>
            <OutcomeEditor rule={rule} base={base} variants={variants} dispatch={dispatch} issues={issues} />
          </>
        )}
      </div>
    </fieldset>
  );
}
