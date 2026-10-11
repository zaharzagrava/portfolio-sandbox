import { formatMoney } from '@/lib/utils';

/**
 * The lines of an order or of the cart, grouped by shop, and its total (W03 FR-041). Display fields only: no query, no
 * state, no event, so it renders on the server and the review, pay and success pages share it. Money is integer minor units
 * formatted with the currency of the amount; text only, ids as keys.
 */

export type Money = { amountMinor: number; currency: string };

export type SummaryLine = {
  /** React key (the product id). */
  id: string;
  title: string;
  quantity: number;
  /** The line total; `null` when the line cannot be priced (shown as a dash). */
  lineTotal: Money | null;
  /** A short label under the title, e.g. "Out of stock". */
  note?: string;
};

export type SummaryGroup = { id: string; name: string; lines: SummaryLine[] };

export function OrderLines({ groups }: { groups: readonly SummaryGroup[] }) {
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.id} aria-label={group.name} className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">{group.name}</h2>
          <ul className="divide-y">
            {group.lines.map((line) => (
              <li key={line.id} className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="break-words font-medium">{line.title}</p>
                  <p className="text-muted-foreground">Quantity {line.quantity}</p>
                  {line.note && <p className="mt-1 text-xs font-medium text-red-700 dark:text-red-300">{line.note}</p>}
                </div>
                <p className="shrink-0 font-medium tabular-nums">{line.lineTotal ? formatMoney(line.lineTotal.amountMinor, line.lineTotal.currency) : '—'}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function OrderTotals({ totals, label = 'Estimated total' }: { totals: readonly Money[]; label?: string }) {
  return (
    <dl className="flex items-baseline justify-between gap-4">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="text-right text-lg font-semibold tabular-nums">
        {totals.map((total) => (
          <span key={total.currency} className="block">
            {formatMoney(total.amountMinor, total.currency)}
          </span>
        ))}
      </dd>
    </dl>
  );
}

export function OrderSummary({ groups, totals, totalLabel }: { groups: readonly SummaryGroup[]; totals: readonly Money[]; totalLabel?: string }) {
  return (
    <div className="space-y-4">
      <OrderLines groups={groups} />
      <OrderTotals totals={totals} label={totalLabel} />
    </div>
  );
}
