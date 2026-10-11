'use client';

import type { CartPageLine } from '@marketplace-sandbox/contracts';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { subtotalsByCurrency, unitCount } from '@/lib/cart/totals';
import { checkoutHref, signInHref } from '@/lib/routes';
import { formatMoney } from '@/lib/utils';

const MIXED_CURRENCIES = "Items in different currencies can't be bought together.";

/** The primary action: **Checkout** for a member, **Sign in to check out** (back to /checkout afterwards) for a guest (AS-10). */
function PrimaryAction({ authenticated, className }: { authenticated: boolean; className?: string }) {
  return (
    <Button asChild size="lg" className={className}>
      {authenticated ? <Link href={checkoutHref()}>Checkout</Link> : <Link href={signInHref(checkoutHref())}>Sign in to check out</Link>}
    </Button>
  );
}

/**
 * The cart summary (W03 AS-03, AS-09, AS-10, FR-007, FR-040): "Subtotal ({n} items)" as the exact integer sum over the
 * available lines, one amount per currency when the cart mixes currencies (with the note that they can't be bought
 * together), "Subtotal unavailable" while the product details failed, and the primary action. At mobile widths a bar
 * fixed to the bottom repeats the subtotal and the action while this summary is out of view, and never covers the
 * element that has focus.
 */
export function CartSummary({ lines, detailsUnavailable, authenticated }: { lines: CartPageLine[]; detailsUnavailable: boolean; authenticated: boolean }) {
  const headingId = useId();
  const panel = useRef<HTMLElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(true);

  const subtotals = subtotalsByCurrency(lines);
  const units = unitCount(lines);
  const mixed = subtotals.length > 1;

  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => setInView(entry?.isIntersecting ?? true));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (inView) return;
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      const barBox = bar.current?.getBoundingClientRect();
      // The bar is hidden by CSS from 1024 px up (an empty box): nothing can be covered then.
      if (!(target instanceof HTMLElement) || !barBox || barBox.height === 0 || bar.current?.contains(target)) return;
      const box = target.getBoundingClientRect();
      if (box.bottom > barBox.top && box.top < barBox.bottom) target.scrollIntoView({ block: 'center' });
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, [inView]);

  const barAmount = detailsUnavailable ? 'Subtotal unavailable' : subtotals.length === 0 ? '—' : subtotals.map((entry) => formatMoney(entry.subtotalMinor, entry.currency)).join(' · ');

  return (
    <>
      <section ref={panel} aria-labelledby={headingId} className="rounded-lg border bg-card p-4 lg:sticky lg:top-20">
        <h2 id={headingId} className="mb-3 text-lg font-semibold">
          Order summary
        </h2>
        {detailsUnavailable ? (
          <p className="font-medium">Subtotal unavailable</p>
        ) : mixed ? (
          <div>
            <p className="text-muted-foreground">{`Subtotal (${units} ${units === 1 ? 'item' : 'items'})`}</p>
            <ul className="mt-1 space-y-1 font-semibold">
              {subtotals.map((entry) => (
                <li key={entry.currency}>{formatMoney(entry.subtotalMinor, entry.currency)}</li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-muted-foreground">{MIXED_CURRENCIES}</p>
          </div>
        ) : (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">{`Subtotal (${units} ${units === 1 ? 'item' : 'items'})`}</span>
            <span className="text-lg font-semibold">{subtotals[0] ? formatMoney(subtotals[0].subtotalMinor, subtotals[0].currency) : '—'}</span>
          </div>
        )}
        <PrimaryAction authenticated={authenticated} className="mt-4 w-full" />
      </section>

      {inView ? null : (
        <div ref={bar} className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 border-t bg-background px-4 py-3 lg:hidden">
          <p className="min-w-0 [overflow-wrap:anywhere] text-base font-semibold">{barAmount}</p>
          <PrimaryAction authenticated={authenticated} className="h-auto min-h-11 max-w-[55%] shrink whitespace-normal text-center" />
        </div>
      )}
    </>
  );
}
