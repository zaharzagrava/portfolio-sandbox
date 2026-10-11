'use client';

import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { fetchCartLines, MAX_LINE_QUANTITY, writeCartLine } from '@/lib/api/cart';
import { queryKeys } from '@/lib/query-keys';
import { cartHref } from '@/lib/routes';

export type BuyAgainItem = { productId: string; title: string; quantity: number };

/**
 * **Buy these items again** (W03 AS-59) for the pay step's ended orders: each line goes back in the cart with the cart's
 * current quantity plus the order's (never above 20), one write after another; then the cart opens with a status toast.
 * No checkout is started. When lines cannot be added the buyer stays here and is told which ones.
 */
export function BuyAgainButton({ items }: { items: readonly BuyAgainItem[] }) {
  const client = useQueryClient();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<string[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = async () => {
    if (pending) return;
    setPending(true);
    setFailed([]);
    const couldNot: string[] = [];
    try {
      const cart = await client.fetchQuery({ queryKey: queryKeys.cart.lines(), queryFn: fetchCartLines, staleTime: 0 });
      for (const item of items) {
        const current = cart.lines.find((line) => line.productId === item.productId)?.quantity ?? 0;
        try {
          await writeCartLine(client, item.productId, Math.min(MAX_LINE_QUANTITY, current + item.quantity));
        } catch {
          couldNot.push(item.title);
        }
      }
    } catch {
      couldNot.push(...items.map((item) => item.title));
    }
    if (!alive.current) return;
    setPending(false);
    if (couldNot.length > 0) {
      setFailed(couldNot);
      return;
    }
    toast.success('Items added to your cart');
    router.push(cartHref());
  };

  return (
    <div className="space-y-2">
      <Button type="button" className="min-h-11 sm:min-h-8" disabled={pending} aria-busy={pending} onClick={() => void run()}>
        {pending ? 'Adding items…' : 'Buy these items again'}
      </Button>
      {failed.length > 0 && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          Couldn&apos;t add: {failed.join(', ')}.{' '}
          <Link href={cartHref()} className="font-medium underline">
            View cart
          </Link>
        </p>
      )}
    </div>
  );
}
