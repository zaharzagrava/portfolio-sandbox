'use client';

import { Minus, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { MAX_LINE_QUANTITY } from '@/lib/api/cart';

const MIN_QUANTITY = 1;
export const QUANTITY_HINT = `Maximum ${MAX_LINE_QUANTITY} per item`;
export const QUANTITY_RANGE_MESSAGE = `Enter a quantity from ${MIN_QUANTITY} to ${MAX_LINE_QUANTITY}`;

/**
 * Quantity of one cart line (W03 AS-04..AS-06, FR-040): a group "Quantity of {title}" with **−**, a numeric field labelled
 * the same, and **+**. The buttons change by one within 1..20 (**−** is disabled at 1: removal is the explicit Remove; **+**
 * at 20 with the hint "Maximum 20 per item" as its description). A typed value is committed on Enter or blur: 1..20 is
 * sent, anything else (empty, 0, 21, decimals, text) puts the saved value back and announces the range. The displayed
 * quantity is always the one the cache holds (the write is optimistic), so a rollback needs nothing here. Targets are 44 px
 * at mobile. `busy` is the line's pending writes (`aria-busy`).
 */
export function QuantityControl({ title, quantity, busy, onChange }: { title: string; quantity: number; busy: boolean; onChange: (quantity: number) => void }) {
  const hintId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const atMinimum = quantity <= MIN_QUANTITY;
  const atMaximum = quantity >= MAX_LINE_QUANTITY;
  const label = `Quantity of ${title}`;

  const step = (delta: number) => {
    setDraft(null);
    setMessage('');
    onChange(quantity + delta);
  };

  const commit = () => {
    if (draft === null) return;
    const typed = draft.trim();
    setDraft(null);
    if (/^\d+$/.test(typed)) {
      const value = Number(typed);
      if (value >= MIN_QUANTITY && value <= MAX_LINE_QUANTITY) {
        setMessage('');
        if (value !== quantity) onChange(value);
        return;
      }
    }
    setMessage(QUANTITY_RANGE_MESSAGE);
  };

  return (
    <div className="flex flex-col gap-1">
      <div role="group" aria-label={label} aria-busy={busy} className="flex items-center gap-1">
        <Button type="button" variant="outline" size="icon" className="size-11 lg:size-9" aria-label={`Decrease quantity of ${title}`} disabled={atMinimum} onClick={() => step(-1)}>
          <Minus aria-hidden="true" className="size-4" />
        </Button>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-label={label}
          value={draft ?? String(quantity)}
          onChange={(event) => {
            setDraft(event.target.value);
            setMessage('');
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commit();
          }}
          className="h-11 w-14 rounded-md border border-input bg-background px-2 text-center text-base tabular-nums focus-visible:outline-2 focus-visible:outline-ring lg:h-9"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-11 lg:size-9"
          aria-label={`Increase quantity of ${title}`}
          aria-describedby={atMaximum ? hintId : undefined}
          disabled={atMaximum}
          onClick={() => step(1)}
        >
          <Plus aria-hidden="true" className="size-4" />
        </Button>
      </div>
      {atMaximum ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {QUANTITY_HINT}
        </p>
      ) : null}
      <p role="status" className="text-xs text-destructive empty:hidden">
        {message}
      </p>
    </div>
  );
}
