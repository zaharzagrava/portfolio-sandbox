'use client';

import type { Dispatch } from 'react';
import { FLAG_BUCKET_BY } from '@marketplace-sandbox/contracts';
import type { Draft, DraftAction } from '@/lib/admin/flags/draft';
import { Field, NativeSelect, VariantSelect } from './field';

/** Default and off variants, and the bucketing unit (W06 AS-17, AS-20). Choices list exactly the current variants. */
export function BindingsSection({ draft, dispatch, issues = {}, readOnly = false }: { draft: Draft; dispatch: Dispatch<DraftAction>; issues?: Record<string, string>; readOnly?: boolean }) {
  const keys = draft.variants.map((variant) => variant.key);
  return (
    <fieldset disabled={readOnly} className="space-y-3">
      <legend className="text-base font-semibold">Default and off variants</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="flag-default-variant" label="Default variant" hint="Served when no rule matches." error={issues['flag-default-variant']}>
          {(props) => <VariantSelect {...props} variants={keys} value={draft.defaultVariant} onChange={(value) => dispatch({ type: 'edit', patch: { defaultVariant: value } })} />}
        </Field>
        <Field id="flag-off-variant" label="Off variant" hint="Served when the flag is disabled or killed." error={issues['flag-off-variant']}>
          {(props) => <VariantSelect {...props} variants={keys} value={draft.offVariant} onChange={(value) => dispatch({ type: 'edit', patch: { offVariant: value } })} />}
        </Field>
      </div>
      <Field id="flag-bucket-by" label="Bucket by" hint="The unit a percentage rollout splits." error={issues['flag-bucket-by']}>
        {(props) => (
          <NativeSelect {...props} value={draft.bucketBy} onChange={(event) => dispatch({ type: 'edit', patch: { bucketBy: event.target.value } })}>
            {FLAG_BUCKET_BY.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
    </fieldset>
  );
}
