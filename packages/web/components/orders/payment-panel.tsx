'use client';

import { Button } from '@/components/ui/button';
import type { OrderPageResponse } from '@/lib/api/orders';
import { paymentStatusText } from '@/lib/orders/status';
import { formatMoney } from '@/lib/utils';

/**
 * The payment section of the order aggregate (W03 AS-55, AS-56, FR-062). With a payment: its status text and amount.
 * Without one but with a `payment` error: the rest of the page stays and the panel offers Reload. Without either, nothing.
 */
export function PaymentPanel({ page, onReload }: { page: OrderPageResponse; onReload: () => void }) {
  const { payment, errors } = page;
  const failed = errors.some((entry) => entry.section === 'payment');
  if (!payment && !failed) return null;
  return (
    <section aria-labelledby="order-payment-heading" role="region" className="space-y-2">
      <h2 id="order-payment-heading" className="text-sm font-semibold">
        Payment
      </h2>
      {payment ? (
        <dl className="flex items-baseline justify-between gap-4 text-sm">
          <dt>{paymentStatusText(payment.status)}</dt>
          <dd className="font-medium tabular-nums">{formatMoney(payment.amountMinor, payment.currency)}</dd>
        </dl>
      ) : (
        <div className="space-y-2 text-sm">
          <p>Payment details are unavailable right now.</p>
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" onClick={onReload}>
            Reload
          </Button>
        </div>
      )}
    </section>
  );
}
