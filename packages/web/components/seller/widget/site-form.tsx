'use client';

import { useState, type FormEvent } from 'react';
import { WIDGET_LIMITS, type UpdateWidgetSiteRequest } from '@marketplace-sandbox/contracts';
import { DialogProblem, FieldError, fieldMessages } from '@/components/seller/developers/shared';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { originRejectionOf, useCreateWidgetSite, useUpdateWidgetSite, type RevealSecret, type WidgetSite } from '@/lib/api/seller-widget';
import { sellerProblemCopy } from '@/lib/seller/problem-copy';

export type ProductOption = { id: string; title: string };

const REASON: Record<string, string> = {
  not_https: 'must start with https://',
  not_an_origin: 'must be only a scheme, a host and an optional port, with no path',
  userinfo: 'must not contain a user name or password',
  wildcard: 'wildcards are not allowed',
  ip_literal: 'IP addresses are not allowed',
  localhost: 'localhost is not allowed',
  single_label_host: 'needs a full domain name',
  trailing_dot: 'must not end with a dot',
  malformed: 'is not a valid address',
  bad_port: 'has an invalid port',
};

/** One address per line (commas work too); blanks and repeats are dropped. */
export function parseOrigins(text: string): string[] {
  return [...new Set(text.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean))];
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item, index) => item === b[index]);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item) => b.includes(item));

/**
 * "Add site" and "Edit site" (S44 `POST sites`, `PATCH sites/:id`). An edit sends only what changed plus `expectedVersion`,
 * the version the form was loaded with; after `409 site_version_conflict`, "Load latest" takes the current values and version.
 * The identity secret of a new site goes to `onReveal` and is never kept here.
 */
export function SiteFormDialog({
  shopId,
  open,
  onOpenChange,
  site,
  latest,
  products,
  onReveal,
}: {
  shopId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The site as it was when the dialog opened; absent when adding. */
  site?: WidgetSite;
  /** The same site as the list holds it now. */
  latest?: WidgetSite;
  products: ProductOption[];
  onReveal: RevealSecret;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        {open && <SiteForm shopId={shopId} site={site} latest={latest} products={products} onOpenChange={onOpenChange} onReveal={onReveal} />}
      </DialogContent>
    </Dialog>
  );
}

function SiteForm({ shopId, site, latest, products, onOpenChange, onReveal }: Omit<Parameters<typeof SiteFormDialog>[0], 'open'>) {
  const create = useCreateWidgetSite(shopId);
  const update = useUpdateWidgetSite(shopId);
  const editing = site !== undefined;
  const [base, setBase] = useState<WidgetSite | undefined>(site);
  const [name, setName] = useState(site?.name ?? '');
  const [originsText, setOriginsText] = useState(site?.allowedOrigins.join('\n') ?? '');
  const [featured, setFeatured] = useState<string[]>(site?.featuredProductIds ?? []);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [rejection, setRejection] = useState<{ origin: string; reason: string } | undefined>();
  const [local, setLocal] = useState<{ name?: string; origins?: string }>({});
  const [busy, setBusy] = useState(false);

  const origins = parseOrigins(originsText);
  const trimmed = name.trim();
  const changes: Omit<UpdateWidgetSiteRequest, 'expectedVersion'> = base
    ? {
        ...(trimmed && trimmed !== base.name ? { name: trimmed } : {}),
        ...(!sameList(origins, base.allowedOrigins) ? { allowedOrigins: origins } : {}),
        ...(!sameSet(featured, base.featuredProductIds) ? { featuredProductIds: featured } : {}),
      }
    : {};
  const dirty = Object.keys(changes).length > 0;

  const fields = fieldMessages(problem, ['name', 'origins', 'allowedOrigins', 'featuredProductIds']);
  const originsError =
    local.origins ??
    (rejection ? `${rejection.origin}: ${REASON[rejection.reason] ?? 'is not allowed'}` : undefined) ??
    fields.byField.origins ??
    fields.byField.allowedOrigins;
  const featuredError = fields.byField.featuredProductIds;
  const nameError = local.name ?? fields.byField.name;
  const knownIds = new Set(products.map((product) => product.id));
  const options: ProductOption[] = [...products, ...featured.filter((id) => !knownIds.has(id)).map((id) => ({ id, title: `Product ${id.slice(0, 8)}` }))];
  const copy = problem ? sellerProblemCopy(problem) : undefined;
  const stale = editing && copy?.action === 'load-latest' && latest !== undefined;
  const shownAsField = rejection !== undefined || Object.keys(fields.byField).length > 0;

  function loadLatest() {
    if (!latest) return;
    setBase(latest);
    setName(latest.name);
    setOriginsText(latest.allowedOrigins.join('\n'));
    setFeatured(latest.featuredProductIds);
    setProblem(null);
    setRejection(undefined);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setProblem(null);
    setRejection(undefined);
    const errors = {
      ...(origins.length === 0 ? { origins: 'Add at least one address.' } : origins.length > WIDGET_LIMITS.originsPerSite ? { origins: `Add at most ${WIDGET_LIMITS.originsPerSite} addresses.` } : {}),
      ...(editing && !trimmed ? { name: 'Enter a name.' } : {}),
    };
    setLocal(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    try {
      if (base) await update.mutateAsync({ siteId: base.id, body: { ...changes, expectedVersion: base.version } });
      else await create.mutateAsync({ body: { ...(trimmed ? { name: trimmed } : {}), origins, ...(featured.length ? { featuredProductIds: featured } : {}) }, reveal: onReveal });
      onOpenChange(false);
    } catch (error) {
      setProblem(problemFromError(error));
      setRejection(originRejectionOf(error));
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string, checked: boolean) {
    setFeatured((current) => (checked ? [...current, id] : current.filter((item) => item !== id)));
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-4" noValidate>
      <DialogHeader>
        <DialogTitle>{editing ? 'Edit site' : 'Add site'}</DialogTitle>
        <DialogDescription>The widget only works on the addresses you list here.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor="widget-name">Name</Label>
        <Input id="widget-name" value={name} maxLength={WIDGET_LIMITS.name.max} placeholder={editing ? undefined : WIDGET_LIMITS.name.default} autoComplete="off" aria-invalid={nameError ? true : undefined} aria-describedby={nameError ? 'widget-name-error' : undefined} onChange={(event) => setName(event.target.value)} />
        <FieldError id="widget-name-error">{nameError}</FieldError>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="widget-origins">Allowed origins</Label>
        <Textarea id="widget-origins" rows={3} value={originsText} placeholder="https://www.example.com" spellCheck={false} aria-invalid={originsError ? true : undefined} aria-describedby={originsError ? 'widget-origins-error widget-origins-hint' : 'widget-origins-hint'} onChange={(event) => setOriginsText(event.target.value)} />
        <p id="widget-origins-hint" className="text-xs text-muted-foreground">
          One address per line, up to {WIDGET_LIMITS.originsPerSite}. Use https and no path.
        </p>
        <FieldError id="widget-origins-error">{originsError}</FieldError>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Featured products</legend>
        {options.length === 0 && <p className="text-sm text-muted-foreground">No active products to feature yet.</p>}
        {options.map((product) => {
          const checked = featured.includes(product.id);
          return (
            <div key={product.id} className="flex min-h-11 items-center gap-2 sm:min-h-0">
              <Checkbox id={`featured-${product.id}`} checked={checked} disabled={!checked && featured.length >= WIDGET_LIMITS.featuredProducts} onCheckedChange={(next) => toggle(product.id, next === true)} />
              <Label htmlFor={`featured-${product.id}`} className="font-normal">
                {product.title}
              </Label>
            </div>
          );
        })}
        <FieldError id="widget-featured-error">{featuredError}</FieldError>
      </fieldset>

      {problem && !shownAsField && (
        <div className="space-y-2">
          <DialogProblem problem={problem} />
          {stale && (
            <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" onClick={loadLatest}>
              Load latest
            </Button>
          )}
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || (editing && !dirty)} aria-busy={busy}>
          {editing ? 'Save changes' : 'Add site'}
        </Button>
      </DialogFooter>
    </form>
  );
}
