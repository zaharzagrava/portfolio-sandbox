'use client';

import { useState, type FormEvent } from 'react';
import { API_KEY_LIMITS, API_KEY_SCOPES, type ApiKeyScope, type CreatedApiKey } from '@marketplace-sandbox/contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useCreateKey, type Reveal } from '@/lib/api/seller-developers';
import { DialogProblem, FieldError, fieldMessages } from './shared';

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The expiry may be tomorrow through 365 days ahead (UTC days; W04 AS-48). */
function expiryBounds() {
  const now = Date.now();
  return { min: isoDay(now + DAY_MS), max: isoDay(now + API_KEY_LIMITS.expiresInDaysMax * DAY_MS) };
}

/**
 * "Create key" (W04 AS-45, AS-48..AS-50). The form lives only while the dialog is open, so closing it clears the values; a
 * refusal keeps them. The created secret goes to `onReveal`, never into this component's state.
 */
export function CreateKeyDialog({
  shopId,
  open,
  onOpenChange,
  onReveal,
  returnTo,
}: {
  shopId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReveal: Reveal<CreatedApiKey>;
  /** This page, for the link to two-step setup (AS-49). */
  returnTo: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open && <CreateKeyForm shopId={shopId} onOpenChange={onOpenChange} onReveal={onReveal} returnTo={returnTo} />}</DialogContent>
    </Dialog>
  );
}

function CreateKeyForm({ shopId, onOpenChange, onReveal, returnTo }: { shopId: string; onOpenChange: (open: boolean) => void; onReveal: Reveal<CreatedApiKey>; returnTo: string }) {
  const create = useCreateKey(shopId);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['products:read']);
  const [livemode, setLivemode] = useState(false);
  const [expires, setExpires] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [bounds] = useState(expiryBounds);

  const fields = fieldMessages(problem, ['name', 'scopes', 'expiresAt']);
  const trimmed = name.trim();

  function toggle(scope: ApiKeyScope, checked: boolean) {
    setScopes((current) => (checked ? API_KEY_SCOPES.filter((item) => item === scope || current.includes(item)) : current.filter((item) => item !== scope)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || create.isPending) return;
    setProblem(null);
    try {
      await create.mutateAsync({ body: { name: trimmed, scopes, livemode, ...(expires ? { expiresAt: `${expires}T00:00:00.000Z` } : {}) }, reveal: onReveal });
      onOpenChange(false);
    } catch (error) {
      setProblem(problemFromError(error));
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Create key</DialogTitle>
        <DialogDescription>The full key is shown once, right after you create it.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor="key-name">Name</Label>
          <span className="text-xs text-muted-foreground">
            {name.length}/{API_KEY_LIMITS.name.max}
          </span>
        </div>
        <Input id="key-name" value={name} maxLength={API_KEY_LIMITS.name.max} required autoComplete="off" aria-invalid={fields.byField.name ? true : undefined} aria-describedby={fields.byField.name ? 'key-name-error' : undefined} onChange={(event) => setName(event.target.value)} />
        <FieldError id="key-name-error">{fields.byField.name}</FieldError>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Scopes</legend>
        {API_KEY_SCOPES.map((scope) => {
          const checked = scopes.includes(scope);
          return (
            <div key={scope} className="flex min-h-11 items-center gap-2 sm:min-h-0">
              <Checkbox id={`scope-${scope}`} checked={checked} disabled={checked && scopes.length === 1} onCheckedChange={(next) => toggle(scope, next === true)} />
              <Label htmlFor={`scope-${scope}`} className="font-normal">
                {scope}
              </Label>
            </div>
          );
        })}
        {scopes.length === 1 && <p className="text-xs text-muted-foreground">A key needs at least one scope.</p>}
        <FieldError id="key-scopes-error">{fields.byField.scopes}</FieldError>
      </fieldset>

      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <Label htmlFor="key-live">Live mode</Label>
          <p id="key-live-note" className="text-xs text-muted-foreground">
            Live keys act on real data.
          </p>
        </div>
        <Switch id="key-live" checked={livemode} aria-describedby="key-live-note" onCheckedChange={setLivemode} />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="key-expires">Expires (optional)</Label>
        <Input id="key-expires" type="date" min={bounds.min} max={bounds.max} value={expires} aria-describedby={fields.byField.expiresAt ? 'key-expires-error' : undefined} onChange={(event) => setExpires(event.target.value)} />
        <FieldError id="key-expires-error">{fields.byField.expiresAt}</FieldError>
      </div>

      {problem && fields.alert && <DialogProblem problem={problem} returnTo={returnTo} />}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={!trimmed || create.isPending} aria-busy={create.isPending}>
          Create key
        </Button>
      </DialogFooter>
    </form>
  );
}
