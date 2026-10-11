'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ShoppingCart } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { fetchCartLines, MAX_LINE_QUANTITY, useCartLines, writeCartLine } from '@/lib/api/cart';
import { problemFromError } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';
import { trackAddToCart } from '@/lib/checkout/events';
import { queryKeys } from '@/lib/query-keys';
import { cartHref } from '@/lib/routes';

/**
 * Adds one unit of a product (W03 AS-02, FR-003). The cart API sets absolute quantities, so the cart is read first and the
 * write sends that quantity plus one (never above 20). While the add runs the button reads "Adding…" and is disabled; on
 * success a status toast offers **View cart** and one `add_to_cart` event is emitted; on failure an alert toast explains
 * (AS-07). `category` is the product's category slug, handed over by the product page, for the event only.
 */
export function AddToCartButton({ productId, category, disabled }: { productId: string; category?: string; disabled?: boolean }) {
  const client = useQueryClient();
  const router = useRouter();
  const { data: cart } = useCartLines();
  const [pending, setPending] = useState(false);

  const inCart = cart?.lines.find((line) => line.productId === productId)?.quantity ?? 0;
  const atMaximum = inCart >= MAX_LINE_QUANTITY;

  const add = async () => {
    if (pending) return;
    setPending(true);
    try {
      const fresh = await client.fetchQuery({ queryKey: queryKeys.cart.lines(), queryFn: fetchCartLines, staleTime: 0 });
      const current = fresh.lines.find((line) => line.productId === productId)?.quantity ?? 0;
      if (current >= MAX_LINE_QUANTITY) return;
      await writeCartLine(client, productId, current + 1);
      trackAddToCart({ productId, category });
      toast.success('Added to cart', { id: 'cart-added', action: { label: 'View cart', onClick: () => router.push(cartHref()) } });
    } catch (error) {
      const copy = problemCopy('cart', problemFromError(error), { operation: 'write' });
      toast.error(copy.text, copy.reference ? { description: copy.reference } : undefined);
    } finally {
      setPending(false);
    }
  };

  const label = pending ? 'Adding…' : disabled ? 'Out of stock' : atMaximum ? 'Maximum 20 in cart' : 'Add to cart';

  return (
    <Button size="lg" className="w-full font-medium sm:w-auto" onClick={add} disabled={disabled || atMaximum || pending} aria-busy={pending}>
      <ShoppingCart aria-hidden="true" className="mr-2 h-4 w-4" />
      {label}
    </Button>
  );
}
