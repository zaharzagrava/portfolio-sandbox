'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ProblemPanel } from '@/components/seller/problem-states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { fetchProduct, useAdjustStock, type InventoryRow } from '@/lib/api/seller-products';
import { STOCK_ERROR, stockError } from './product-form';

/** The codes that say the row on screen is out of date: the page shows the explanation (AS-41) and the list refetches. */
export const STALE_ROW_CODES = ['product_archived', 'invalid_transition', 'product_not_found'];

/**
 * Stock adjustment from a row (W04 AS-38): a small popover anchored to the stock cell with one whole-number field. It saves
 * against the version the row carried (a search row carries none, so the member view is read first). When a sale changed the
 * stock meanwhile (`409 version_conflict`) it names the new stock and keeps the member's number for them to confirm again.
 */
export function StockPopover({
  shopId,
  row,
  open,
  onOpenChange,
  onStale,
  children,
}: {
  shopId: string;
  row: InventoryRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row was archived, restored or removed elsewhere. */
  onStale: (problem: Problem) => void;
  /** The stock cell the popover hangs from. */
  children: ReactNode;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span>{children}</span>
      </PopoverAnchor>
      <PopoverContent
        align="end"
        aria-label={`Adjust stock of ${row.title}`}
        // The row menu hands focus back to its button as it closes, which can land just after this popover opened: that is not
        // the member leaving the popover.
        onFocusOutside={(event) => {
          if (event.target instanceof HTMLElement && event.target.getAttribute('aria-label') === `Actions for ${row.title}`) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const trigger = Array.from(document.querySelectorAll<HTMLElement>('button[aria-label]')).find((button) => button.getAttribute('aria-label') === `Actions for ${row.title}`);
          trigger?.focus();
        }}
      >
        <StockForm shopId={shopId} row={row} onDone={() => onOpenChange(false)} onStale={onStale} />
      </PopoverContent>
    </Popover>
  );
}

function StockForm({ shopId, row, onDone, onStale }: { shopId: string; row: InventoryRow; onDone: () => void; onStale: (problem: Problem) => void }) {
  const [text, setText] = useState(String(row.quantity));
  const [version, setVersion] = useState(row.version);
  const [invalid, setInvalid] = useState(false);
  const [changedTo, setChangedTo] = useState<number | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const adjust = useAdjustStock(shopId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (adjust.isPending) return;
    if (stockError(text)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setProblem(null);
    try {
      const expectedVersion = version ?? (await fetchProduct(shopId, row.id)).version;
      await adjust.mutateAsync({ productId: row.id, quantity: Number(text.trim()), expectedVersion });
      toast.success('Stock updated');
      onDone();
    } catch (error) {
      const failure = problemFromError(error);
      if (failure.code === 'version_conflict') {
        try {
          const latest = await fetchProduct(shopId, row.id);
          setVersion(latest.version);
          setChangedTo(latest.quantity);
          return;
        } catch (reload) {
          setProblem(problemFromError(reload));
          return;
        }
      }
      if (failure.code && STALE_ROW_CODES.includes(failure.code)) {
        onStale(failure);
        onDone();
        return;
      }
      setProblem(failure);
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`stock-${row.id}`}>New stock</Label>
        <Input
          id={`stock-${row.id}`}
          value={text}
          inputMode="numeric"
          autoComplete="off"
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? `stock-${row.id}-error` : changedTo !== null ? `stock-${row.id}-changed` : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setInvalid(false);
          }}
        />
        {invalid && (
          <p id={`stock-${row.id}-error`} className="text-sm text-destructive">
            {STOCK_ERROR}
          </p>
        )}
        {changedTo !== null && (
          <p id={`stock-${row.id}-changed`} role="status" className="text-sm text-amber-900 dark:text-amber-100">
            Stock changed to {changedTo} while you were editing.
          </p>
        )}
      </div>
      {problem && <ProblemPanel problem={problem} context={{ place: 'dialog' }} />}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" disabled={adjust.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" className="min-h-11 sm:min-h-7" disabled={adjust.isPending} aria-busy={adjust.isPending}>
          Update stock
        </Button>
      </div>
    </form>
  );
}
