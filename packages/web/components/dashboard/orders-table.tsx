'use client';

import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiErrorMessage } from '@/lib/api/errors';
import { isCancellable, useCancelOrder, type OrderSummary } from '@/lib/api/orders';
import { formatMoney } from '@/lib/utils';

const shortId = (id: string) => id.slice(0, 8).toUpperCase();

export function OrdersTable({ orders, allowCancel = false }: { orders: OrderSummary[]; allowCancel?: boolean }) {
  const cancel = useCancelOrder();
  if (orders.length === 0) return <p className="text-sm text-muted-foreground" data-testid="orders-empty">No orders yet.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Order</TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Total</TableHead>
          {allowCancel && <TableHead />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => (
          <TableRow key={order.id} data-testid="order-row">
            <TableCell className="font-mono text-sm">{shortId(order.id)}</TableCell>
            <TableCell>{new Date(order.createdAt).toLocaleDateString()}</TableCell>
            <TableCell>
              <Badge variant={order.status === 'CANCELLED' || order.status === 'REFUNDED' ? 'secondary' : 'default'} data-testid="order-status">
                {order.status}
              </Badge>
            </TableCell>
            <TableCell className="text-right">{formatMoney(Number(order.total))}</TableCell>
            {allowCancel && (
              <TableCell className="text-right">
                {isCancellable(order.status) && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={cancel.isPending}
                    onClick={() =>
                      cancel.mutate(order.id, {
                        onSuccess: () => toast.success('Order cancelled'),
                        onError: (error) => toast.error(apiErrorMessage(error, 'Could not cancel the order.')),
                      })
                    }
                  >
                    Cancel
                  </Button>
                )}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
