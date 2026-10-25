'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PRODUCT_LIMITS, type ProductCreateRequest, type ProductUpdateRequest } from '@marketplace-sandbox/contracts';
import { ProblemPanel } from '@/components/seller/problem-states';
import { Button } from '@/components/ui/button';
import { currentOpener } from '@/lib/focus-opener';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { newIdempotencyKey } from '@/lib/api/idempotency';
import { ARCHIVED_ELSEWHERE, fetchProduct, isArchivedNow, useCreateProduct, useProduct, useUpdateProduct, type ProductMemberView } from '@/lib/api/seller-products';
import { fractionDigitsOf, parseMoneyInput } from '@/lib/seller/money-input';

/**
 * The create and edit form of a product (W04 FR-027, AS-33..AS-37, AS-95). The form checks only what the UI can know
 * (required text, a decimal price with the currency's fraction digits, a whole stock); the server decides the rest, and its
 * `errors[]` land under the matching field. Edits send only the changed fields with the `expectedVersion` of the load, and a
 * `version_conflict` never overwrites: "Load latest" replaces the form values and says the unsaved edits were dropped.
 */

type Field = 'title' | 'brand' | 'category' | 'description' | 'price' | 'stock';
type Values = Record<Field, string>;
type Errors = Partial<Record<Field, string>>;

const ORDER: Field[] = ['title', 'brand', 'category', 'description', 'price', 'stock'];
/** Wire field names of a `validation_failed` answer to the form's fields. */
const WIRE_FIELD: Record<string, Field> = { title: 'title', brand: 'brand', category: 'category', description: 'description', priceMinor: 'price', currency: 'price', quantity: 'stock' };

/** Integer minor units as the text a seller types ("2450", 2 digits: "24.50"), by string work only. */
function minorToInput(minor: number, fractionDigits: number): string {
  if (fractionDigits === 0) return String(minor);
  const digits = String(minor).padStart(fractionDigits + 1, '0');
  return `${digits.slice(0, -fractionDigits)}.${digits.slice(-fractionDigits)}`;
}

function valuesOf(product: ProductMemberView, fractionDigits: number): Values {
  return {
    title: product.title,
    brand: product.brand,
    category: product.category,
    description: product.description,
    price: minorToInput(product.priceMinor, fractionDigits),
    stock: String(product.quantity),
  };
}

const EMPTY: Values = { title: '', brand: '', category: '', description: '', price: '', stock: '0' };

function textError(value: string, label: string, max: number): string | undefined {
  if (value.trim() === '') return `Enter a ${label}.`;
  return [...value.trim()].length > max ? `Use at most ${max} characters.` : undefined;
}

function priceError(text: string, fractionDigits: number): string | undefined {
  const result = parseMoneyInput(text, fractionDigits);
  if (!result.ok) {
    switch (result.reason) {
      case 'empty':
        return 'Enter a price.';
      case 'negative':
        return "A price can't be negative.";
      case 'format':
        return fractionDigits === 0 ? 'Enter a whole number.' : 'Enter a price like 24.50.';
      case 'too_many_decimals':
        return fractionDigits === 0 ? 'Use a whole number.' : `Use at most ${fractionDigits} decimal ${fractionDigits === 1 ? 'place' : 'places'}.`;
      case 'too_large':
        return 'That price is too large.';
    }
  }
  if (result.minor < PRODUCT_LIMITS.priceMinor.min) return 'A price must be more than zero.';
  if (result.minor > PRODUCT_LIMITS.priceMinor.max) return 'That price is too large.';
  return undefined;
}

export const STOCK_ERROR = 'Enter a whole number, 0 or more.';
export function stockError(text: string): string | undefined {
  const value = text.trim();
  return /^\d{1,10}$/.test(value) && Number(value) <= PRODUCT_LIMITS.quantity.max ? undefined : STOCK_ERROR;
}

function validate(values: Values, fractionDigits: number): Errors {
  const errors: Errors = {};
  const title = textError(values.title, 'title', PRODUCT_LIMITS.title.max);
  const brand = textError(values.brand, 'brand', PRODUCT_LIMITS.brand.max);
  const category = textError(values.category, 'category', PRODUCT_LIMITS.category.max);
  if (title) errors.title = title;
  if (brand) errors.brand = brand;
  if (category) errors.category = category;
  if ([...values.description.trim()].length > PRODUCT_LIMITS.description.max) errors.description = `Use at most ${PRODUCT_LIMITS.description.max} characters.`;
  const price = priceError(values.price, fractionDigits);
  if (price) errors.price = price;
  const stock = stockError(values.stock);
  if (stock) errors.stock = stock;
  return errors;
}

const trimmed = (values: Values): Values => ({ ...values, title: values.title.trim(), brand: values.brand.trim(), category: values.category.trim(), description: values.description.trim(), price: values.price.trim(), stock: values.stock.trim() });

function dirtyFields(values: Values, base: Values): Field[] {
  const now = trimmed(values);
  const was = trimmed(base);
  return ORDER.filter((field) => now[field] !== was[field]);
}

type Props = {
  mode: 'create' | 'edit';
  shopId: string;
  /** ISO 4217 code of the platform currency (create) or of the product (edit); it names the price field. */
  currency: string;
  fractionDigits: number;
  product?: ProductMemberView;
  onSaved: () => void;
  onCancel?: () => void;
  /** Focus the first field once mounted (the edit dialog mounts the form after its load). */
  autoFocus?: boolean;
};

export function ProductForm({ mode, shopId, currency, fractionDigits, product, onSaved, onCancel, autoFocus = false }: Props) {
  const prefix = useId();
  const id = (field: Field) => `${prefix}-${field}`;
  const [base, setBase] = useState<Values>(() => (product ? valuesOf(product, fractionDigits) : EMPTY));
  const [version, setVersion] = useState(product?.version ?? 0);
  const [values, setValues] = useState<Values>(base);
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<Problem | null>(null);
  const [counting, setCounting] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(false);
  // One key per create attempt: a repeat of the same request gets the same product back; a changed form is a new attempt.
  const [attemptKey, setAttemptKey] = useState<string | null>(null);
  const create = useCreateProduct(shopId);
  const update = useUpdateProduct(shopId);
  const pending = create.isPending || update.isPending || loadingLatest;

  useEffect(() => {
    if (autoFocus) document.getElementById(`${prefix}-title`)?.focus();
  }, [autoFocus, prefix]);

  const clientErrors = validate(values, fractionDigits);
  const shown: Errors = {};
  for (const field of ORDER) {
    const message = (submitted ? clientErrors[field] : undefined) ?? serverErrors[field];
    if (message) shown[field] = message;
  }
  const shownFields = ORDER.filter((field) => shown[field]);
  const unchanged = mode === 'edit' && dirtyFields(values, base).length === 0;

  function change(field: Field, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setServerErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
    setProblem(null);
    setNotice(null);
    setAttemptKey(null);
  }

  function focusField(field: Field) {
    document.getElementById(id(field))?.focus();
  }

  function updateBody(): ProductUpdateRequest | null {
    const now = trimmed(values);
    const was = trimmed(base);
    const body: Record<string, unknown> = { expectedVersion: version };
    let changed = false;
    for (const field of ['title', 'brand', 'category', 'description'] as const) {
      if (now[field] !== was[field]) {
        body[field] = now[field];
        changed = true;
      }
    }
    const price = parseMoneyInput(now.price, fractionDigits);
    const priceWas = parseMoneyInput(was.price, fractionDigits);
    if (price.ok && priceWas.ok && price.minor !== priceWas.minor) {
      body.priceMinor = price.minor;
      changed = true;
    }
    if (Number(now.stock) !== Number(was.stock)) {
      body.quantity = Number(now.stock);
      changed = true;
    }
    return changed ? (body as ProductUpdateRequest) : null;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setSubmitted(true);
    setProblem(null);
    setNotice(null);
    setConflict(false);
    const firstInvalid = ORDER.find((field) => clientErrors[field]);
    if (firstInvalid) {
      focusField(firstInvalid);
      return;
    }
    const now = trimmed(values);
    try {
      if (mode === 'create') {
        const price = parseMoneyInput(now.price, fractionDigits);
        if (!price.ok) return;
        const body: ProductCreateRequest = {
          title: now.title,
          brand: now.brand,
          category: now.category,
          ...(now.description ? { description: now.description } : {}),
          priceMinor: price.minor,
          currency,
          quantity: Number(now.stock),
        };
        const idempotencyKey = attemptKey ?? newIdempotencyKey();
        setAttemptKey(idempotencyKey);
        await create.mutateAsync({ ...body, idempotencyKey });
        toast.success('Product created');
      } else if (product) {
        const body = updateBody();
        if (body) {
          await update.mutateAsync({ productId: product.id, body });
          toast.success('Product updated');
        }
      }
      onSaved();
    } catch (error) {
      const failure = problemFromError(error);
      // a definite refusal ends the attempt; only a lost answer (no status, 5xx) is retried with the same key
      if (failure.status >= 400 && failure.status < 500) setAttemptKey(null);
      if (failure.code === 'validation_failed' && failure.errors.length > 0) {
        const next: Errors = {};
        for (const entry of failure.errors) {
          const field = WIRE_FIELD[entry.field];
          if (field && !next[field]) next[field] = 'Check this field.';
        }
        if (Object.keys(next).length > 0) {
          setServerErrors(next);
          const first = ORDER.find((field) => next[field]);
          if (first) focusField(first);
          return;
        }
      }
      if (failure.code === 'version_conflict' && mode === 'edit') {
        // the change that made the version stale may be an archive: then "Load latest" would only lead to a refusal
        if (product && (await isArchivedNow(shopId, product.id))) setProblem(ARCHIVED_ELSEWHERE);
        else setConflict(true);
        return;
      }
      setProblem(failure);
    }
  }

  async function loadLatest() {
    if (!product) return;
    setLoadingLatest(true);
    try {
      const latest = await fetchProduct(shopId, product.id);
      const next = valuesOf(latest, fractionDigits);
      setBase(next);
      setValues(next);
      setVersion(latest.version);
      setServerErrors({});
      setSubmitted(false);
      setConflict(false);
      setNotice('Latest values loaded. Your unsaved changes were dropped.');
    } catch (error) {
      setConflict(false);
      setProblem(problemFromError(error));
    } finally {
      setLoadingLatest(false);
    }
  }

  const priceLabel = `Price (${currency})`;
  const fieldProps = (field: Field) => ({
    id: id(field),
    value: values[field],
    onChange: (event: { target: { value: string } }) => change(field, event.target.value),
    'aria-invalid': shown[field] ? (true as const) : undefined,
    'aria-describedby': shown[field] ? `${id(field)}-error` : undefined,
    // Read-only, not disabled: a disabled field cannot take the focus the error handling moves to.
    readOnly: pending,
  });
  const message = (field: Field) =>
    shown[field] ? (
      <p id={`${id(field)}-error`} className="text-sm text-destructive">
        {shown[field]}
      </p>
    ) : null;

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="grid gap-4">
      {shownFields.length > 0 && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          <p>Fix the highlighted fields.</p>
          <ul className="mt-1 list-disc pl-5">
            {shownFields.map((field) => (
              <li key={field}>{shown[field]}</li>
            ))}
          </ul>
        </div>
      )}
      {conflict && (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
          <p>This product changed since you opened it.</p>
          <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11 sm:min-h-7" onClick={() => void loadLatest()}>
            Load latest
          </Button>
        </div>
      )}
      {notice && (
        <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          {notice}
        </p>
      )}
      {problem && <ProblemPanel problem={problem} context={{ place: 'dialog' }} onActiveChange={setCounting} />}

      <div className="grid gap-1.5">
        <Label htmlFor={id('title')}>Title</Label>
        <Input {...fieldProps('title')} aria-required="true" autoComplete="off" />
        {message('title')}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={id('brand')}>Brand</Label>
          <Input {...fieldProps('brand')} aria-required="true" autoComplete="off" />
          {message('brand')}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={id('category')}>Category</Label>
          <Input {...fieldProps('category')} aria-required="true" autoComplete="off" />
          {message('category')}
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={id('description')}>Description (optional)</Label>
        <Textarea {...fieldProps('description')} rows={3} />
        {message('description')}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={id('price')}>{priceLabel}</Label>
          <Input {...fieldProps('price')} aria-required="true" inputMode="decimal" autoComplete="off" />
          {message('price')}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={id('stock')}>Stock</Label>
          <Input {...fieldProps('stock')} aria-required="true" inputMode="numeric" autoComplete="off" />
          {message('stock')}
        </div>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel && (
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" className="min-h-11 sm:min-h-8" disabled={pending || unchanged || (counting && problem !== null)} aria-busy={pending}>
          {mode === 'create' ? (create.isPending ? 'Creating…' : 'Create product') : update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

/**
 * The dialog around the form (AS-94): opening moves focus to the first field, Tab stays inside, Escape closes, and focus
 * returns to the control that opened it. The edit dialog reads the member view first, because list rows from the search carry
 * no `version` (it shows a skeleton until it arrives) and the version of that read is the one the save is checked against.
 */
export function ProductDialog({
  open,
  onOpenChange,
  mode,
  shopId,
  productId,
  currency,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  shopId: string;
  productId?: string;
  /** Platform currency (create). Edit uses the product's own currency. */
  currency?: { code: string; fractionDigits: number };
}) {
  const content = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const loaded = useProduct(shopId, mode === 'edit' && open ? productId : undefined);
  const product = loaded.data;
  const title = mode === 'create' ? 'Add product' : 'Edit product';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={content}
        showCloseButton={false}
        className="max-h-dvh overflow-y-auto max-sm:h-dvh max-sm:max-w-none max-sm:rounded-none sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          opener.current = currentOpener();
          const first = content.current?.querySelector<HTMLElement>('input, textarea');
          (first ?? content.current)?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener.current?.isConnected) opener.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{mode === 'create' ? 'Title, brand, category, price and stock are required.' : 'Only the fields you change are saved.'}</DialogDescription>
        </DialogHeader>
        {mode === 'create' && currency && (
          <ProductForm mode="create" shopId={shopId} currency={currency.code} fractionDigits={currency.fractionDigits} onSaved={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />
        )}
        {mode === 'edit' && product && (
          <ProductForm
            key={product.id}
            mode="edit"
            shopId={shopId}
            currency={product.currency}
            fractionDigits={fractionDigitsOf(product.currency)}
            product={product}
            autoFocus
            onSaved={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
          />
        )}
        {mode === 'edit' && !product && loaded.isError && (
          <ProblemPanel problem={problemFromError(loaded.error)} context={{ kind: 'read', place: 'dialog' }} onRetry={() => void loaded.refetch()} />
        )}
        {mode === 'edit' && !product && !loaded.isError && (
          <div aria-hidden="true" data-skeleton="product-form" className="grid gap-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
