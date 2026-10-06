'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorMessage } from '@/lib/api/errors';
import { useCreateProduct, useMyShops, useShopProducts } from '@/lib/api/shops';
import { formatMoney } from '@/lib/utils';

const LOW_STOCK = 5;

const EMPTY = { title: '', description: '', brand: '', category: '', price: '', quantity: '' };

function AddProductDialog({ shopId }: { shopId: string }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const create = useCreateProduct(shopId);
  const field = (key: keyof typeof EMPTY) => ({
    id: `product-${key}`,
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
  const priceCents = Math.round(Number(form.price) * 100);
  const valid = form.title.trim() && form.brand.trim() && form.category.trim() && priceCents > 0 && Number(form.quantity) >= 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate(
      {
        title: form.title.trim(),
        description: form.description.trim(),
        brand: form.brand.trim(),
        category: form.category.trim().toLowerCase(),
        price: priceCents,
        quantity: Math.floor(Number(form.quantity) || 0),
      },
      {
        onSuccess: () => {
          toast.success('Product created');
          setForm(EMPTY);
          setOpen(false);
        },
        onError: (error) => toast.error(apiErrorMessage(error, 'Could not create the product.')),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          Add Product
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New product</DialogTitle>
            <DialogDescription>It appears in search within seconds (outbox → indexer).</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <div className="space-y-1">
              <Label htmlFor="product-title">Title</Label>
              <Input {...field('title')} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="product-description">Description</Label>
              <Textarea {...field('description')} rows={3} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="product-brand">Brand</Label>
                <Input {...field('brand')} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="product-category">Category</Label>
                <Input {...field('category')} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="product-price">Price (USD)</Label>
                <Input {...field('price')} type="number" min="0.01" step="0.01" required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="product-quantity">Stock</Label>
                <Input {...field('quantity')} type="number" min="0" step="1" required />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!valid || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create product'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function InventoryView() {
  const shops = useMyShops();
  const shop = shops.data?.[0];
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(input.trim()), 300);
    return () => clearTimeout(timer);
  }, [input]);
  const products = useShopProducts(shop?.id, q);

  if (shops.isLoading) return <div className="flex h-full items-center justify-center">Loading...</div>;
  if (!shop) {
    return (
      <p className="text-muted-foreground">
        You don&apos;t have a shop yet. <Link href="/dashboard/seller" className="underline">Open one</Link> to manage inventory.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Inventory</h1>
          <p className="text-muted-foreground">Products of {shop.name}.</p>
        </div>
        <AddProductDialog shopId={shop.id} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Products</CardTitle>
          <CardDescription>Search is shop-scoped and typo tolerant (SD-37).</CardDescription>
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search your products…" aria-label="Search your products" className="max-w-sm" />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Price</TableHead>
                <TableHead>Stock</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground">Loading…</TableCell>
                </TableRow>
              ) : !products.data?.length ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground" data-testid="inventory-empty">
                    {q ? 'No matching products.' : 'No products yet.'}
                  </TableCell>
                </TableRow>
              ) : (
                products.data.map((product) => (
                  <TableRow key={product.id} data-testid="inventory-row">
                    <TableCell className="font-medium">
                      <Link href={`/products/${product.id}`} className="hover:underline">{product.title}</Link>
                    </TableCell>
                    <TableCell>{formatMoney(product.price)}</TableCell>
                    <TableCell>{product.quantity}</TableCell>
                    <TableCell>
                      <Badge variant={product.quantity === 0 ? 'destructive' : product.quantity <= LOW_STOCK ? 'secondary' : 'default'}>
                        {product.quantity === 0 ? 'Out of stock' : product.quantity <= LOW_STOCK ? 'Low stock' : 'In stock'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
