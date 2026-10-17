'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { CreatedWebhookEndpoint, CreateWebhookEndpointRequest, UpdateWebhookEndpointRequest, WebhookEndpointDto, WebhookEventTypeInfo } from '@marketplace-sandbox/contracts';
import { SectionError } from '@/components/seller/problem-states';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useApiVersion, useCreateWebhook, useUpdateWebhook, useWebhookEventTypes, type Reveal } from '@/lib/api/seller-developers';
import { problemDetailOf } from '@/lib/seller/problem-copy';
import { DialogProblem, FieldError, fieldMessages, NativeSelect } from './shared';

const RESOURCE_LABEL: Record<string, string> = { order: 'Orders', product: 'Products', payout: 'Payouts', ping: 'Test events' };
const DEFAULT_EVENT = 'order.paid';

type Group = { resource: string; label: string; events: { type: string; description?: string }[] };

/** Catalogue entries grouped by resource in the API's order; an event the endpoint has but the catalogue does not still shows by its name. */
function groupEvents(catalogue: readonly WebhookEventTypeInfo[], selected: readonly string[]): Group[] {
  const groups: Group[] = [];
  for (const info of catalogue) {
    let group = groups.find((item) => item.resource === info.resource);
    if (!group) {
      group = { resource: info.resource, label: RESOURCE_LABEL[info.resource] ?? info.resource, events: [] };
      groups.push(group);
    }
    group.events.push({ type: info.type, description: info.description });
  }
  const known = new Set(catalogue.map((info) => info.type as string));
  const extra = [...new Set(selected)].filter((type) => !known.has(type));
  if (extra.length > 0) groups.push({ resource: 'other', label: 'Other events', events: extra.map((type) => ({ type })) });
  return groups;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((item) => b.includes(item));

/**
 * "Add endpoint" and "Edit endpoint" (W04 AS-57..AS-60). Event choices come from the catalogue, the API version starts at
 * the shop's pin, and every refusal of the URL is explained under the URL. Editing sends only what changed.
 */
export function EndpointFormDialog({
  shopId,
  open,
  onOpenChange,
  endpoint,
  onReveal,
}: {
  shopId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present: edit this endpoint; absent: add one. */
  endpoint?: WebhookEndpointDto;
  onReveal: Reveal<CreatedWebhookEndpoint>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        {open && <EndpointForm shopId={shopId} endpoint={endpoint} onOpenChange={onOpenChange} onReveal={onReveal} />}
      </DialogContent>
    </Dialog>
  );
}

function EndpointForm({ shopId, endpoint, onOpenChange, onReveal }: { shopId: string; endpoint?: WebhookEndpointDto; onOpenChange: (open: boolean) => void; onReveal: Reveal<CreatedWebhookEndpoint> }) {
  const editing = endpoint !== undefined;
  const create = useCreateWebhook(shopId);
  const update = useUpdateWebhook(shopId);
  const catalogue = useWebhookEventTypes(shopId);
  const version = useApiVersion(shopId);
  const pending = create.isPending || update.isPending;

  const [url, setUrl] = useState(endpoint?.url ?? '');
  const [picked, setPicked] = useState<string[] | null>(null);
  const [pickedVersion, setPickedVersion] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ problem: Problem; detail?: string } | null>(null);

  const items = catalogue.data?.items;
  const firstEvent: string | undefined = items?.some((info) => info.type === DEFAULT_EVENT) ? DEFAULT_EVENT : items?.[0]?.type;
  const defaultEvents: string[] = firstEvent ? [firstEvent] : [];
  const events: string[] = picked ?? (endpoint ? [...endpoint.events] : defaultEvents);
  const apiVersion = pickedVersion ?? endpoint?.apiVersion ?? version.data?.version ?? '';
  const versionOptions = [...new Set([apiVersion, endpoint?.apiVersion, ...(version.data?.supported.filter((entry) => entry.status !== 'retired').map((entry) => entry.version) ?? [])].filter((item): item is string => Boolean(item)))];

  const fields = fieldMessages(failure?.problem ?? null, ['url', 'events', 'apiVersion'], failure?.detail);
  const trimmed = url.trim();

  const changes: UpdateWebhookEndpointRequest = {};
  if (endpoint) {
    if (trimmed !== endpoint.url) changes.url = trimmed;
    if (!sameSet(events, endpoint.events)) changes.events = events as UpdateWebhookEndpointRequest['events'];
    if (apiVersion && apiVersion !== endpoint.apiVersion) changes.apiVersion = apiVersion;
  }
  const canSubmit = trimmed.length > 0 && events.length > 0 && !pending && (editing ? Object.keys(changes).length > 0 : Boolean(items));

  function toggle(type: string, checked: boolean) {
    setPicked(checked ? [...events, type] : events.filter((item) => item !== type));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setFailure(null);
    try {
      if (endpoint) {
        await update.mutateAsync({ endpointId: endpoint.id, body: changes });
        toast.success('Endpoint updated');
      } else {
        await create.mutateAsync({ body: { url: trimmed, events: events as CreateWebhookEndpointRequest['events'], ...(apiVersion ? { apiVersion } : {}) }, reveal: onReveal });
      }
      onOpenChange(false);
    } catch (error) {
      setFailure({ problem: problemFromError(error), detail: problemDetailOf(error) });
    }
  }

  const groups = items ? groupEvents(items, [...(endpoint?.events ?? []), ...events]) : endpoint ? groupEvents([], endpoint.events) : [];

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{editing ? 'Edit endpoint' : 'Add endpoint'}</DialogTitle>
        <DialogDescription>We send the events you choose to this address, signed with a secret only you hold.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-1.5">
        <Label htmlFor="endpoint-url">Endpoint URL</Label>
        <Input
          id="endpoint-url"
          type="url"
          inputMode="url"
          value={url}
          placeholder="https://example.com/webhooks"
          required
          autoComplete="off"
          aria-invalid={fields.byField.url ? true : undefined}
          aria-describedby={fields.byField.url ? 'endpoint-url-error' : undefined}
          onChange={(event) => setUrl(event.target.value)}
        />
        <FieldError id="endpoint-url-error">{fields.byField.url}</FieldError>
      </div>

      {catalogue.isError && !endpoint ? (
        <SectionError error={catalogue.error} onRetry={() => void catalogue.refetch()} />
      ) : (
        <div className="grid gap-3" aria-busy={catalogue.isPending}>
          {groups.map((group) => (
            <fieldset key={group.resource} className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">{group.label}</legend>
              {group.events.map((info) => {
                const checked = events.includes(info.type);
                return (
                  <div key={info.type} className="flex min-h-11 items-start gap-2 sm:min-h-0">
                    <Checkbox id={`event-${info.type}`} className="mt-0.5" checked={checked} disabled={checked && events.length === 1} onCheckedChange={(next) => toggle(info.type, next === true)} />
                    <Label htmlFor={`event-${info.type}`} className="block font-normal">
                      <span className="font-mono text-xs">{info.type}</span>
                      {info.description && <span className="block text-xs text-muted-foreground">{info.description}</span>}
                    </Label>
                  </div>
                );
              })}
            </fieldset>
          ))}
          {events.length === 1 && <p className="text-xs text-muted-foreground">An endpoint needs at least one event.</p>}
          <FieldError id="endpoint-events-error">{fields.byField.events}</FieldError>
        </div>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="endpoint-version">API version</Label>
        <NativeSelect id="endpoint-version" value={apiVersion} disabled={versionOptions.length === 0} aria-describedby={fields.byField.apiVersion ? 'endpoint-version-error' : undefined} onChange={(event) => setPickedVersion(event.target.value)}>
          {versionOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NativeSelect>
        <FieldError id="endpoint-version-error">{fields.byField.apiVersion}</FieldError>
      </div>

      {failure && fields.alert && <DialogProblem problem={failure.problem} detail={failure.detail} />}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSubmit} aria-busy={pending}>
          {editing ? 'Save changes' : 'Add endpoint'}
        </Button>
      </DialogFooter>
    </form>
  );
}
