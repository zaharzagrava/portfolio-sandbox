'use client';

import type { Dispatch } from 'react';
import { FLAG_LIMITS } from '@marketplace-sandbox/contracts';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { Draft, DraftAction } from '@/lib/admin/flags/draft';
import { Field } from './field';
import { CLIENT_SIDE_NOTICE, EXPIRY_HELP } from './notices';

/**
 * Description, Owner, Client-side, Expires and the Enabled switch (W06 AS-17, AS-24, AS-29, AS-34). The switch takes effect
 * only on Save. A killed flag cannot be enabled: the switch is off and disabled with the reason; if the draft still says
 * enabled (the flag was killed behind the admin's back) the switch stays usable so it can be turned off.
 */
export function BasicsSection({
  draft,
  dispatch,
  issues = {},
  readOnly = false,
  killed = false,
}: {
  draft: Draft;
  dispatch: Dispatch<DraftAction>;
  issues?: Record<string, string>;
  readOnly?: boolean;
  /** The live flag is killed. */
  killed?: boolean;
}) {
  const edit = (patch: Extract<DraftAction, { type: 'edit' }>['patch']) => dispatch({ type: 'edit', patch });
  const switchLocked = readOnly || (killed && !draft.enabled);
  return (
    <fieldset disabled={readOnly} className="space-y-4">
      <legend className="text-base font-semibold">Basics</legend>
      <Field id="flag-description" label="Description" error={issues['flag-description']}>
        {(props) => <Textarea {...props} value={draft.description} onChange={(event) => edit({ description: event.target.value })} maxLength={FLAG_LIMITS.description} rows={3} />}
      </Field>
      <Field id="flag-owner" label="Owner" error={issues['flag-owner']}>
        {(props) => <Input {...props} value={draft.owner} onChange={(event) => edit({ owner: event.target.value })} maxLength={FLAG_LIMITS.owner} autoComplete="off" />}
      </Field>
      <div className="space-y-1.5">
        <label className="flex min-h-11 items-center gap-2 text-sm font-medium sm:min-h-8">
          <input
            id="flag-client-side"
            type="checkbox"
            checked={draft.clientSide}
            onChange={(event) => edit({ clientSide: event.target.checked })}
            aria-describedby={draft.clientSide ? 'flag-client-side-notice' : undefined}
            className="size-4"
          />
          Client-side
        </label>
        {draft.clientSide && (
          <p id="flag-client-side-notice" className="text-xs text-muted-foreground">
            {CLIENT_SIDE_NOTICE}
          </p>
        )}
      </div>
      <Field id="flag-expires-at" label="Expires (UTC)" hint={EXPIRY_HELP} error={issues['flag-expires-at']}>
        {(props) => <Input {...props} type="datetime-local" value={draft.expiresAt} onChange={(event) => edit({ expiresAt: event.target.value })} />}
      </Field>
      <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
        <div className="space-y-1">
          <label htmlFor="flag-enabled" className="text-sm font-medium">
            Enabled
          </label>
          <p id="flag-enabled-description" className="text-xs text-muted-foreground">
            {killed ? "A killed flag can't be enabled. Restore it first." : 'When off, everyone gets the off variant.'}
          </p>
        </div>
        <Switch id="flag-enabled" checked={draft.enabled && !(killed && switchLocked)} disabled={switchLocked} aria-describedby="flag-enabled-description" onCheckedChange={(checked) => edit({ enabled: checked })} />
      </div>
    </fieldset>
  );
}
