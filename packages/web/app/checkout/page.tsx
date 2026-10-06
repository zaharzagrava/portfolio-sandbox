'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ShoppingCart } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/hooks/use-auth';
import { apiClient } from '@/lib/api/client';
import { CART_QUERY_KEY, cartTotals, useCart } from '@/lib/api/cart';
import { apiErrorMessage } from '@/lib/api/errors';
import { formatMoney } from '@/lib/utils';

interface CheckoutResult {
  orderId: string;
  status: string;
  total: number;
  currency: string;
  reservedUntil: string | null;
}

/**
 * Checkout (SD-19): reserves stock for the signed-in user's cart and creates the order in one server
 * transaction. Prices and the total are computed by the server; the Idempotency-Key is fixed for the page
 * so a double click or a retry returns the same order instead of creating two.
 */
export default function CheckoutPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { data: items = [], isLoading } = useCart();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const { itemCount, subtotal } = cartTotals(items);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.replace('/login?returnUrl=%2Fcheckout');
  }, [authLoading, isAuthenticated, router]);

  const placeOrder = async () => {
    setSubmitting(true);
    try {
      const { data } = await apiClient.post<CheckoutResult>('/api/checkout', {}, { headers: { 'Idempotency-Key': idempotencyKey } });
      await queryClient.invalidateQueries({ queryKey: CART_QUERY_KEY });
      router.push(`/checkout/success?orderId=${encodeURIComponent(data.orderId)}`);
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Checkout failed. Please try again.'));
      setSubmitting(false);
    }
  };

  if (authLoading || !isAuthenticated || isLoading) {
    return <div className="container mx-auto py-10 px-4 text-muted-foreground">Loading checkout…</div>;
  }

  return (
    <div className="container mx-auto py-10 px-4 md:px-6 max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight mb-8">Checkout</h1>

      {items.length === 0 ? (
        <div className="text-center py-16 border rounded-lg">
          <p className="text-lg font-medium mb-2">Your cart is empty</p>
          <Button asChild>
            <Link href="/search">Browse products</Link>
          </Button>
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShoppingCart className="h-5 w-5" /> Order Summary
            </CardTitle>
            <CardDescription>Placing the order reserves the stock for 15 minutes.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {items.map((item) =>
              item.product ? (
                <div key={item.productId} className="flex justify-between text-sm" data-testid="checkout-line">
                  <span>
                    {item.product.title} × {item.quantity}
                  </span>
                  <span>{formatMoney(item.product.price * item.quantity)}</span>
                </div>
              ) : null,
            )}
            <Separator />
            <div className="flex justify-between font-bold text-lg">
              <span>Total ({itemCount} items)</span>
              <span data-testid="checkout-total">{formatMoney(subtotal)}</span>
            </div>
          </CardContent>
          <CardFooter>
            <Button className="w-full" size="lg" onClick={placeOrder} disabled={submitting}>
              {submitting ? 'Processing...' : 'Place Order'}
            </Button>
          </CardFooter>
        </Card>
      )}
    </div>
  );
}
