import { cancelSentence } from '@/components/checkout/payment-status';
import type { OrderDto } from '@/lib/api/orders';
import { formatMoment } from '@/lib/orders/format';
import { orderStatusText } from '@/lib/orders/status';

/** The order's history as an ordered list, oldest first (W03 AS-55, FR-045): the status as text, its reason, its time. */
export function OrderTimeline({ timeline }: { timeline: OrderDto['timeline'] }) {
  const entries = [...timeline].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return (
    <section aria-labelledby="order-timeline-heading" className="space-y-2">
      <h2 id="order-timeline-heading" className="text-sm font-semibold">
        Timeline
      </h2>
      <ol aria-label="Order timeline" className="space-y-3 border-l pl-4 text-sm">
        {entries.map((entry) => {
          const reason = entry.status === 'CANCELLED' ? cancelSentence(entry.reason) : null;
          return (
            <li key={`${entry.status}:${entry.at}`}>
              <p className="font-medium">{orderStatusText(entry.status)}</p>
              {reason && <p>{reason}</p>}
              <time dateTime={entry.at} title={entry.at} className="text-xs text-muted-foreground">
                {formatMoment(entry.at)}
              </time>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
