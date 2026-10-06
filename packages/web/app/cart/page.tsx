'use client';

import Link from 'next/link';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cartTotals, nextQuantity, useCart, useSetCartQuantity } from '@/lib/api/cart';
import { apiErrorMessage } from '@/lib/api/errors';
import { formatMoney } from '@/lib/utils';

/**
 * Cart (SD-19). Prices come from the catalog, never from the client; the order total is recomputed by the
 * server at checkout (stock reservation + price lock), so this page shows the subtotal only.
 */
export default function CartPage() {
  const { data: items = [], isLoading, isError } = useCart();
  const setQuantity = useSetCartQuantity();
  const { itemCount, subtotal } = cartTotals(items);

  const change = (productId: string, quantity: number) =>
    setQuantity.mutate({ productId, quantity }, { onError: (error) => toast.error(apiErrorMessage(error, 'Could not update the cart.')) });

  return (
    <div className="container mx-auto py-10 px-4 md:px-6">
      <h1 className="text-3xl font-bold tracking-tight mb-8">Shopping Cart</h1>

      {isLoading ? (
        <p className="text-muted-foreground">Loading your cart…</p>
      ) : isError ? (
        <p className="text-destructive">Could not load your cart. Please refresh.</p>
      ) : items.length === 0 ? (
        <div className="text-center py-16 border rounded-lg" data-testid="cart-empty">
          <p className="text-lg font-medium mb-2">Your cart is empty</p>
          <Button asChild>
            <Link href="/search">Browse products</Link>
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>Items ({itemCount})</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="text-center">Quantity</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.productId} data-testid="cart-line">
                        <TableCell>
                          <div className="flex flex-col">
                            {item.product ? (
                              <Link href={`/products/${item.productId}`} className="font-medium hover:underline">
                                {item.product.title}
                              </Link>
                            ) : (
                              <span className="font-medium text-muted-foreground">Product no longer available</span>
                            )}
                            <button
                              type="button"
                              className="text-sm text-destructive text-left mt-1 hover:underline w-fit inline-flex items-center gap-1"
                              onClick={() => change(item.productId, 0)}
                            >
                              <Trash2 className="h-3 w-3" /> Remove
                            </button>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-center gap-2">
                            <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Decrease quantity" onClick={() => change(item.productId, nextQuantity(item.quantity, -1))}>
                              <Minus className="h-3 w-3" />
                            </Button>
                            <span className="w-8 text-center" data-testid="cart-line-quantity">{item.quantity}</span>
                            <Button
                              variant="outline"
                              size="icon"
                              className="h-8 w-8"
                              aria-label="Increase quantity"
                              disabled={item.quantity >= 20 || (item.product !== null && item.quantity >= item.product.quantity)}
                              onClick={() => change(item.productId, nextQuantity(item.quantity, 1))}
                            >
                              <Plus className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">{item.product ? formatMoney(item.product.price) : '—'}</TableCell>
                        <TableCell className="text-right font-medium">{item.product ? formatMoney(item.product.price * item.quantity) : '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>

          <div>
            <Card>
              <CardHeader>
                <CardTitle>Order Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span data-testid="cart-subtotal">{formatMoney(subtotal)}</span>
                </div>
                <Separator />
                <p className="text-xs text-muted-foreground">Stock is reserved and the final total confirmed at checkout.</p>
              </CardContent>
              <CardFooter>
                <Button asChild className="w-full" size="lg">
                  <Link href="/checkout">Proceed to Checkout</Link>
                </Button>
              </CardFooter>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
