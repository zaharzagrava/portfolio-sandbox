'use client';

import { PlusIcon, Trash2Icon } from 'lucide-react';
import type { Dispatch } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { Draft, DraftAction, DraftVariant, VariantType } from '@/lib/admin/flags/draft';
import { Field, NativeSelect } from './field';

const TYPES: { value: VariantType; label: string }[] = [
  { value: 'boolean', label: 'Boolean' },
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'json', label: 'JSON' },
];

/** A type change keeps what still reads: a boolean starts at "true" or "false", the rest keep their text. */
function textForType(type: VariantType, text: string): string {
  if (type === 'boolean') return text === 'true' ? 'true' : 'false';
  return text === 'true' || text === 'false' ? (type === 'string' ? text : '') : text;
}

function VariantRow({ variant, index, dispatch, issues, readOnly }: { variant: DraftVariant; index: number; dispatch: Dispatch<DraftAction>; issues: Record<string, string>; readOnly: boolean }) {
  const set = (patch: Partial<Pick<DraftVariant, 'key' | 'type' | 'text'>>) => dispatch({ type: 'editVariant', uid: variant.uid, patch });
  const base = `variant-${index}`;
  return (
    <fieldset disabled={readOnly} className="space-y-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">Variant {variant.key || index + 1}</legend>
      <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
        <Field id={`${base}-key`} label="Key" error={issues[`${base}-key`]}>
          {(props) => <Input {...props} value={variant.key} onChange={(event) => set({ key: event.target.value })} maxLength={32} autoComplete="off" spellCheck={false} className="font-mono" />}
        </Field>
        <Field id={`${base}-type`} label="Type">
          {(props) => (
            <NativeSelect {...props} value={variant.type} onChange={(event) => set({ type: event.target.value as VariantType, text: textForType(event.target.value as VariantType, variant.text) })}>
              {TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </div>
      <Field id={`${base}-value`} label="Value" error={issues[`${base}-value`]}>
        {(props) => {
          switch (variant.type) {
            case 'boolean':
              return (
                <NativeSelect {...props} value={variant.text === 'true' ? 'true' : 'false'} onChange={(event) => set({ text: event.target.value })}>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </NativeSelect>
              );
            case 'json':
              return <Textarea {...props} value={variant.text} onChange={(event) => set({ text: event.target.value })} rows={4} spellCheck={false} className="font-mono" />;
            case 'number':
              return <Input {...props} value={variant.text} onChange={(event) => set({ text: event.target.value })} inputMode="decimal" autoComplete="off" />;
            default:
              return <Input {...props} value={variant.text} onChange={(event) => set({ text: event.target.value })} autoComplete="off" />;
          }
        }}
      </Field>
      <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" onClick={() => dispatch({ type: 'removeVariant', uid: variant.uid })} aria-label={`Remove variant ${variant.key || index + 1}`}>
        <Trash2Icon aria-hidden="true" />
        Remove
      </Button>
    </fieldset>
  );
}

/** The variants of the flag as typed rows (W06 AS-19): key, type (inferred from the stored value), value control of that type. */
export function VariantsEditor({ draft, dispatch, issues = {}, readOnly = false }: { draft: Draft; dispatch: Dispatch<DraftAction>; issues?: Record<string, string>; readOnly?: boolean }) {
  return (
    <fieldset id="flag-variants" disabled={readOnly} tabIndex={-1} className="space-y-3">
      <legend className="text-base font-semibold">Variants</legend>
      {draft.clientSide && <p className="text-xs text-muted-foreground">Variant values of a client-side flag are visible to every visitor.</p>}
      {issues['flag-variants'] && <p className="text-sm text-destructive">{issues['flag-variants']}</p>}
      <div className="space-y-3">
        {draft.variants.map((variant, index) => (
          <VariantRow key={variant.uid} variant={variant} index={index} dispatch={dispatch} issues={issues} readOnly={readOnly} />
        ))}
      </div>
      <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => dispatch({ type: 'addVariant' })}>
        <PlusIcon aria-hidden="true" />
        Add variant
      </Button>
    </fieldset>
  );
}
