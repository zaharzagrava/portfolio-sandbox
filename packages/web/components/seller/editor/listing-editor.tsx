'use client';

import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import * as Y from 'yjs';
import { ConfirmDialog } from '@/components/seller/confirm-dialog';
import { DialogProblem, FieldError } from '@/components/seller/developers/shared';
import { RateLimitNotice } from '@/components/seller/problem-states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { newIdempotencyKey } from '@/lib/api/idempotency';
import { useShop } from '@/lib/api/seller';
import { connectDraft, currentVersionOf, usePublishDraft, type Draft, type DraftPublishResult } from '@/lib/api/seller-listing-drafts';
import { CollabSession, type Backoff, type SessionState, type SocketLike, type StopReason } from '@/lib/seller/collab-session';
import { formatMinor, readListing, removeSpec, setField, setSpec, setText } from '@/lib/seller/listing-doc';
import { fractionDigitsOf, parseMoneyInput } from '@/lib/seller/money-input';
import { shopCan, useShopWritable } from '@/lib/seller/permissions';
import { VersionsPanel } from './versions-panel';

const STOP_COPY: Record<StopReason, string> = {
  draft_not_found: 'This draft no longer exists.',
  access_revoked: 'You no longer have access to this draft.',
  shop_inactive: "This shop isn't active, so the draft can't be edited.",
  protocol_error: 'Editing stopped because of a connection error. Reload the page to continue.',
  room_full: 'Too many people are editing this draft. Try again later.',
  document_too_large: 'This draft is too large to edit.',
  frame_too_large: 'A change was too large to send. Reload the page and try a smaller change.',
  forbidden: "You can't edit this draft.",
  session_ended: 'Your session ended. Sign in again to continue.',
};

const DRAFT_STATUS_COPY: Record<string, string> = {
  PUBLISHING: 'This draft is being published.',
  PUBLISHED: 'This draft was published. Start a new draft to change the product again.',
  ARCHIVED: 'This draft was archived.',
};

/** Where a `listing_invalid` problem is shown: the field it names, the words by its `code` (`required` or `invalid`). */
const FIELD_NOUN: Record<string, { label: string; noun: string }> = {
  title: { label: 'Title', noun: 'a title' },
  description: { label: 'Description', noun: 'a description' },
  priceMinor: { label: 'Price', noun: 'a price' },
  brand: { label: 'Brand', noun: 'a brand' },
  category: { label: 'Category', noun: 'a category' },
  quantity: { label: 'Stock', noun: 'a stock quantity' },
  specs: { label: 'Specifications', noun: 'the specifications' },
};
const FIELD_ID: Record<string, string> = { title: 'title', description: 'description', priceMinor: 'price', brand: 'brand', category: 'category', quantity: 'quantity', specs: 'specs' };

function fieldMessage(field: string, code: string): string {
  const info = FIELD_NOUN[field] ?? { label: field, noun: 'a value' };
  return code === 'required' ? `Enter ${info.noun} before publishing.` : `${info.label} isn't valid for a listing.`;
}

/** LF, CR and the two Unicode line separators, from code points so the source stays plain. */
const LINE_BREAK = new RegExp(`[${String.fromCharCode(0x0a, 0x0d, 0x2028, 0x2029)}]`);

const browserSocket =(url: string): SocketLike => new WebSocket(url) as unknown as SocketLike;

/** A counter that goes up with every update of `doc`, as an external store. */
function createDocStore(doc: Y.Doc) {
  let version = 0;
  return {
    subscribe: (onChange: () => void) => {
      const handler = () => {
        version += 1;
        onChange();
      };
      doc.on('update', handler);
      return () => doc.off('update', handler);
    },
    get: () => version,
  };
}

function useDocVersion(doc: Y.Doc): number {
  const store = useMemo(() => createDocStore(doc), [doc]);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

const IDLE: SessionState = { status: 'connecting', synced: false, everSynced: false, canWrite: false, denied: false, attempt: 0, retryToken: 0 };
const never = () => () => undefined;

/**
 * The listing editor (W04 F1, S06): the draft's fields edited together with other members over the editing connection. The
 * fields are bound to the shared document, so typing is sent as it happens and other members' changes appear in place; the
 * connection state is always said in words (connecting, live, reconnecting with a countdown, read only, stopped and why).
 * "Publish" asks first and sends one `Idempotency-Key` per attempt; a product that changed since the draft started needs a
 * second, explicit "Publish anyway" (`acknowledgeProductVersion`); `422 listing_invalid` is shown at the fields it names.
 */
export function ListingEditor({
  shopId,
  draft,
  currency = 'EUR',
  createSocket = browserSocket,
  backoff,
}: {
  shopId: string;
  draft: Draft;
  currency?: string;
  /** Opens the connection; replaced in tests. */
  createSocket?: (url: string) => SocketLike;
  backoff?: Backoff;
}) {
  const baseId = useId();
  const shop = useShop(shopId).data;
  const { writable, reason } = useShopWritable(shop);
  const canWriteProducts = shopCan(shop, 'products.write');
  const [doc] = useState(() => new Y.Doc());
  const [session, setSession] = useState<CollabSession | null>(null);
  const options = useRef({ createSocket, backoff });
  useEffect(() => {
    options.current = { createSocket, backoff };
  });

  useEffect(() => {
    const created = new CollabSession({ doc, connect: () => connectDraft(shopId, draft.id), createSocket: (url) => options.current.createSocket(url), backoff: options.current.backoff });
    setSession(created);
    created.start();
    return () => created.destroy();
  }, [doc, shopId, draft.id]);

  const state = useSyncExternalStore(session?.subscribe ?? never, () => session?.getSnapshot() ?? IDLE, () => IDLE);
  const version = useDocVersion(doc);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the change signal of the document
  const listing = useMemo(() => readListing(doc), [doc, version]);
  const fractionDigits = fractionDigitsOf(currency);

  const [published, setPublished] = useState<DraftPublishResult | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [dialogProblem, setDialogProblem] = useState<Problem | null>(null);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const attempt = useRef<{ key: string; ack?: number } | null>(null);
  const publish = usePublishDraft(shopId, draft.id);

  const draftOpen = draft.status === 'DRAFT' && !published;
  const editable = canWriteProducts && writable && draftOpen && state.canWrite && state.everSynced && !state.denied && state.status !== 'stopped';
  const readOnlyReason = !draftOpen ? (published ? null : (DRAFT_STATUS_COPY[draft.status] ?? null)) : state.everSynced && !state.canWrite ? 'You can view this draft but not change it.' : null;

  function edit(field: string, change: () => void) {
    change();
    if (fieldErrors[field] !== undefined) setFieldErrors((all) => Object.fromEntries(Object.entries(all).filter(([name]) => name !== field)));
  }

  function openPublish() {
    attempt.current = { key: newIdempotencyKey() };
    setConflictVersion(null);
    setDialogProblem(null);
    setDialog(true);
  }

  async function confirmPublish() {
    const current = attempt.current ?? { key: newIdempotencyKey() };
    attempt.current = current;
    setDialogProblem(null);
    try {
      const result = await publish.mutateAsync({ key: current.key, body: current.ack === undefined ? {} : { acknowledgeProductVersion: current.ack } });
      setPublished(result);
      setDialog(false);
      setSummary(false);
      setFieldErrors({});
      toast.success(`Published as version ${result.productVersion}`);
    } catch (error) {
      const problem = problemFromError(error);
      if (problem.code === 'product_version_conflict') {
        const now = currentVersionOf(error);
        if (now !== undefined) {
          // The request changes (it now carries the acknowledged version), so it is a new attempt with a new key.
          attempt.current = { key: newIdempotencyKey(), ack: now };
          setConflictVersion(now);
          throw error;
        }
      }
      if (problem.code === 'listing_invalid') {
        const found: Record<string, string> = {};
        for (const item of problem.errors) found[item.field] = fieldMessage(item.field, item.code);
        setFieldErrors(found);
        setSummary(true);
        setDialog(false);
        const first = problem.errors.map((item) => FIELD_ID[item.field]).find((id): id is string => Boolean(id));
        if (first) requestAnimationFrame(() => document.getElementById(`${baseId}-${first}`)?.focus());
        return;
      }
      setDialogProblem(problem);
      throw error;
    }
  }

  const field = (name: string) => `${baseId}-${name}`;
  const errorOf = (name: string) => fieldErrors[name];
  const described = (name: string) => (errorOf(name) ? `${field(FIELD_ID[name] ?? name)}-error` : undefined);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href={`/dashboard/seller/${encodeURIComponent(shopId)}/inventory`} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          Back to inventory
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Edit listing</h1>
        <p className="text-sm text-muted-foreground">{draft.title}</p>
      </div>

      <ConnectionStatus state={state} onRetry={() => session?.restart()} />
      {state.denied && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          Your last change wasn&apos;t saved because you only have read access.
        </p>
      )}
      {readOnlyReason && (
        <p role="status" className="rounded-lg border px-3 py-2 text-sm">
          {readOnlyReason}
        </p>
      )}
      {canWriteProducts && !writable && reason && (
        <p role="status" className="rounded-lg border px-3 py-2 text-sm">
          {reason}
        </p>
      )}
      {published && (
        <p role="status" className="rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-950 dark:border-green-800 dark:bg-green-950/40 dark:text-green-100">
          Published as version {published.productVersion}.{' '}
          <Link href={`/dashboard/seller/${encodeURIComponent(shopId)}/inventory`} className="underline underline-offset-4">
            Back to inventory
          </Link>
        </p>
      )}
      {summary && Object.keys(fieldErrors).length > 0 && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          This draft can&apos;t be published yet. Fix the fields marked below.
        </p>
      )}

      <form className="grid gap-4 sm:grid-cols-2" noValidate onSubmit={(event) => event.preventDefault()}>
        <Field id={field('title')} label="Title" error={errorOf('title')} className="sm:col-span-2">
          <Input id={field('title')} value={listing.title} readOnly={!editable} aria-invalid={errorOf('title') ? true : undefined} aria-describedby={described('title')} onChange={(event) => edit('title', () => setText(doc, 'title', event.target.value))} />
        </Field>
        <Field id={field('description')} label="Description" error={errorOf('description')} className="sm:col-span-2">
          <Textarea id={field('description')} rows={6} value={listing.description} readOnly={!editable} aria-invalid={errorOf('description') ? true : undefined} aria-describedby={described('description')} onChange={(event) => edit('description', () => setText(doc, 'description', event.target.value))} />
        </Field>
        <PriceField id={field('price')} label={`Price (${currency})`} minor={listing.priceMinor} fractionDigits={fractionDigits} readOnly={!editable} error={errorOf('priceMinor')} onCommit={(minor) => edit('priceMinor', () => setField(doc, 'priceMinor', minor))} />
        <Field id={field('quantity')} label="Stock" error={errorOf('quantity')}>
          <WholeNumberInput id={field('quantity')} value={listing.quantity} readOnly={!editable} invalid={Boolean(errorOf('quantity'))} describedBy={described('quantity')} onCommit={(value) => edit('quantity', () => setField(doc, 'quantity', value))} />
        </Field>
        <Field id={field('brand')} label="Brand" error={errorOf('brand')}>
          <Input id={field('brand')} value={listing.brand} readOnly={!editable} aria-invalid={errorOf('brand') ? true : undefined} aria-describedby={described('brand')} onChange={(event) => edit('brand', () => setField(doc, 'brand', event.target.value))} />
        </Field>
        <Field id={field('category')} label="Category" error={errorOf('category')}>
          <Input id={field('category')} value={listing.category} readOnly={!editable} aria-invalid={errorOf('category') ? true : undefined} aria-describedby={described('category')} onChange={(event) => edit('category', () => setField(doc, 'category', event.target.value))} />
        </Field>
      </form>

      <Specs id={field('specs')} specs={listing.specs} editable={editable} error={errorOf('specs')} onSet={(name, value) => edit('specs', () => setSpec(doc, name, value))} onRemove={(name) => edit('specs', () => removeSpec(doc, name))} />

      {canWriteProducts && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!editable || publish.isPending} title={reason ?? undefined} onClick={openPublish}>
            Publish
          </Button>
        </div>
      )}

      <VersionsPanel shopId={shopId} draftId={draft.id} canWrite={canWriteProducts && draftOpen} writable={writable} />

      <ConfirmDialog
        open={dialog}
        onOpenChange={setDialog}
        title={conflictVersion === null ? 'Publish this draft?' : 'Publish anyway?'}
        description={
          conflictVersion === null
            ? 'The product will show this title, description, price and stock. Editing stops while it is published.'
            : `The product changed after this draft was started and is at version ${conflictVersion} now. Publishing replaces those changes with this draft.`
        }
        confirmLabel={conflictVersion === null ? 'Publish' : 'Publish anyway'}
        error={dialogProblem ? <DialogProblem problem={dialogProblem} resource="draft" /> : undefined}
        onConfirm={confirmPublish}
      />
    </div>
  );
}

function ConnectionStatus({ state, onRetry }: { state: SessionState; onRetry: () => void }) {
  if (state.status === 'stopped' && state.stopReason) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
        <p>{STOP_COPY[state.stopReason]}</p>
        {state.stopReason === 'room_full' && (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  if (state.status === 'reconnecting') {
    return (
      <div role="status">
        {state.retryInSeconds ? (
          <RateLimitNotice seconds={state.retryInSeconds} token={state.retryToken} subject="requests" className="!border-amber-300 !bg-amber-50 !text-amber-950" />
        ) : (
          <p className="text-sm">Connection lost. Reconnecting…</p>
        )}
      </div>
    );
  }
  const text = state.status === 'connecting' ? 'Connecting…' : !state.synced ? 'Syncing…' : state.canWrite ? 'Live. Changes are shared as you type.' : 'Live. Read only.';
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {text}
    </p>
  );
}

function Field({ id, label, error, className, children }: { id: string; label: string; error?: string; className?: string; children: ReactNode }) {
  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}

/** A decimal price typed as text; a valid amount is written to the document as integer minor units. */
function PriceField({ id, label, minor, fractionDigits, readOnly, error, onCommit }: { id: string; label: string; minor: number | undefined; fractionDigits: number; readOnly: boolean; error?: string; onCommit: (minor: number | undefined) => void }) {
  const shown = formatMinor(minor, fractionDigits);
  const [text, setTextState] = useState(shown);
  const [problem, setProblem] = useState<string | null>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setTextState(shown);
  }, [shown]);
  return (
    <Field id={id} label={label} error={problem ?? error}>
      <Input
        id={id}
        inputMode="decimal"
        value={text}
        readOnly={readOnly}
        aria-invalid={problem || error ? true : undefined}
        aria-describedby={problem || error ? `${id}-error` : undefined}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          setTextState(shown);
          setProblem(null);
        }}
        onChange={(event) => {
          const value = event.target.value;
          setTextState(value);
          if (value.trim() === '') {
            setProblem(null);
            return onCommit(undefined);
          }
          const parsed = parseMoneyInput(value, fractionDigits);
          if (parsed.ok) {
            setProblem(null);
            onCommit(parsed.minor);
          } else {
            setProblem(parsed.reason === 'too_many_decimals' ? `Use at most ${fractionDigits} decimal places.` : 'Enter an amount like 24.50.');
          }
        }}
      />
    </Field>
  );
}

function WholeNumberInput({ id, value, readOnly, invalid, describedBy, onCommit }: { id: string; value: number | undefined; readOnly: boolean; invalid: boolean; describedBy?: string; onCommit: (value: number | undefined) => void }) {
  const shown = value === undefined ? '' : String(value);
  const [text, setTextState] = useState(shown);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setTextState(shown);
  }, [shown]);
  return (
    <Input
      id={id}
      inputMode="numeric"
      value={text}
      readOnly={readOnly}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={describedBy}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        setTextState(shown);
      }}
      onChange={(event) => {
        const value = event.target.value;
        setTextState(value);
        if (value.trim() === '') return onCommit(undefined);
        if (/^[0-9]{1,10}$/.test(value.trim())) onCommit(Number(value.trim()));
      }}
    />
  );
}

/** One row per specification; the name is the key, so a new name is a new row and "Remove" deletes the row. */
function Specs({ id, specs, editable, error, onSet, onRemove }: { id: string; specs: [string, string][]; editable: boolean; error?: string; onSet: (name: string, value: string) => void; onRemove: (name: string) => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  function add() {
    const key = name.trim();
    const text = value.trim();
    if (!key || !text) return setProblem('Enter a name and a value.');
    if (key.includes(':') || LINE_BREAK.test(key + text)) return setProblem("Names can't contain a colon and values must be one line.");
    setProblem(null);
    onSet(key, text);
    setName('');
    setValue('');
  }

  return (
    <section aria-labelledby={`${id}-heading`} id={id} tabIndex={-1} className="space-y-3">
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        Specifications
      </h2>
      <FieldError id={`${id}-error`}>{error}</FieldError>
      {specs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No specifications yet.</p>
      ) : (
        <ul aria-label="Specifications" className="space-y-2">
          {specs.map(([key, current]) => (
            <li key={key} className="flex flex-wrap items-center gap-2">
              <span className="w-40 text-sm font-medium">{key}</span>
              <Input aria-label={`Value of ${key}`} className="max-w-sm flex-1" value={current} readOnly={!editable} onChange={(event) => onSet(key, event.target.value)} />
              {editable && (
                <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${key}`} onClick={() => onRemove(key)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <label htmlFor={`${id}-name`} className="text-sm font-medium">
              Specification name
            </label>
            <Input id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-value`} className="text-sm font-medium">
              Specification value
            </label>
            <Input id={`${id}-value`} value={value} onChange={(event) => setValue(event.target.value)} />
          </div>
          <Button type="button" variant="outline" onClick={add}>
            Add specification
          </Button>
          {problem && <p className="w-full text-sm text-destructive">{problem}</p>}
        </div>
      )}
    </section>
  );
}
