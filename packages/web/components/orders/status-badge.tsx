import { Badge } from '@/components/ui/badge';
import type { OrderStatus } from '@/lib/api/orders';
import { orderStatusText } from '@/lib/orders/status';

/** The status as text in a badge (FR-060): the words carry the meaning, the variant only adds emphasis. */
export function StatusBadge({ status }: { status: OrderStatus }) {
  const variant = status === 'CANCELLED' || status === 'REFUNDED' ? 'secondary' : status === 'RESERVED' || status === 'PENDING' ? 'outline' : 'default';
  return <Badge variant={variant}>{orderStatusText(status)}</Badge>;
}
