'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';
import { useCancelOrder, type OrderStatus } from '@/lib/api/orders';
import { orderStatusText, shortOrderId } from '@/lib/orders/status';

/**
 * **Cancel** with its confirmation (W03 AS-54): focus opens on Keep order, the confirm button reads "Cancelling…" while the
 * request runs, and on success focus goes to `returnFocus()` (the row's View link) because the Cancel button is gone by
 * then. `409 order_not_cancellable` and `404` close the dialog with a toast (the list re-reads); `429` keeps it open and
 * disables the button for the wait; any other problem is shown inside.
 */
export function CancelOrderDialog({ orderId, returnFocus }: { orderId: string; returnFocus: () => HTMLElement | null }) {
  const cancel = useCancelOrder();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [blocked, setBlocked] = useState(false);
  const unblock = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const done = useRef(false);

  useEffect(() => () => {
    if (unblock.current) clearTimeout(unblock.current);
  }, []);

  const confirm = () => {
    setProblem(null);
    cancel.mutate(orderId, {
      onSuccess: () => {
        done.current = true;
        setOpen(false);
        toast.success('Order cancelled');
      },
      onError: (error) => {
        const failure = problemFromError(error);
        if (failure.code === 'order_not_cancellable') {
          const current = (error as { response?: { data?: { currentStatus?: string } } }).response?.data?.currentStatus;
          const text = current ? orderStatusText(current as OrderStatus) : undefined;
          done.current = true;
          setOpen(false);
          toast.error(problemCopy('orders', failure, { statusText: text }).text);
          return;
        }
        if (failure.code === 'order_not_found') {
          done.current = true;
          setOpen(false);
          toast.error(problemCopy('orders', failure).text);
          return;
        }
        if (failure.status === 429 && failure.retryAfterSeconds) {
          setBlocked(true);
          unblock.current = setTimeout(() => setBlocked(false), failure.retryAfterSeconds * 1000);
        }
        setProblem(failure);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (cancel.isPending) return;
        if (next) {
          done.current = false;
          setProblem(null);
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7">
          Cancel
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          keep.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (!done.current) return;
          event.preventDefault();
          returnFocus()?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Cancel this order?</DialogTitle>
          <DialogDescription>The items go back on sale.</DialogDescription>
        </DialogHeader>
        {problem && <ProblemAlert problem={problem} surface="orders" />}
        <DialogFooter>
          <Button ref={keep} type="button" variant="outline" className="min-h-11 sm:min-h-8" disabled={cancel.isPending} onClick={() => setOpen(false)}>
            Keep order
          </Button>
          <Button type="button" variant="destructive" className="min-h-11 sm:min-h-8" disabled={cancel.isPending || blocked} aria-busy={cancel.isPending} onClick={confirm}>
            {cancel.isPending ? 'Cancelling…' : 'Cancel order'}
          </Button>
        </DialogFooter>
        <span className="sr-only">Order #{shortOrderId(orderId)}</span>
      </DialogContent>
    </Dialog>
  );
}
