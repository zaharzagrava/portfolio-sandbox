'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { PaymentFieldsProps } from './payment-fields';

/**
 * Test payment methods of the sandbox (spec H7: only `pm_card_visa` is documented; decline and 3-D Secure tokens are added
 * here when S13 names them). A pick is a provider token name, not a card: no number is typed or shown anywhere.
 */
export const SANDBOX_CARDS = [{ id: 'pm_card_visa', label: 'Visa test card (payment succeeds)' }] as const;

/** Shown instead of the provider's fields in non-production builds with `NEXT_PUBLIC_PAYMENTS_SANDBOX=true`. */
export default function SandboxCardPicker({ onChange, register, describedBy }: PaymentFieldsProps) {
  const name = useId();
  const [selected, setSelected] = useState<string>(SANDBOX_CARDS[0].id);
  const current = useRef(selected);

  useEffect(() => {
    current.current = selected;
  }, [selected]);

  useEffect(() => {
    register(async () => ({ ok: true, paymentMethodId: current.current }));
    onChange({ complete: true });
    // The registration and the first report happen once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <fieldset aria-describedby={describedBy} className="space-y-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">Card details</legend>
      <p className="text-sm text-muted-foreground">Test mode: choose a test card. No card number is entered.</p>
      {SANDBOX_CARDS.map((card) => (
        <label key={card.id} className="flex min-h-11 items-center gap-3 text-sm">
          <input type="radio" name={name} value={card.id} checked={selected === card.id} onChange={() => setSelected(card.id)} />
          {card.label}
        </label>
      ))}
    </fieldset>
  );
}
