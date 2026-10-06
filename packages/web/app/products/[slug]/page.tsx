import { Suspense } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronRight, MessagesSquare, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Metadata } from 'next';
import { formatMoney } from '@/lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ProductCard } from '@/components/product-card';
import { AddToCartButton } from '@/components/add-to-cart-button';
import { AskProduct } from '@/components/product/ask-product';
import { ProductDiscussions } from '@/components/product/product-discussions';
import { recommendationToCard, serverApiUrl, type ProductDetail, type Recommendation } from '@/lib/api/catalog';

type Props = { params: Promise<{ slug: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The URL slug is the product id (the API has no slug field). */
async function loadProduct(id: string): Promise<ProductDetail | null> {
  if (!UUID.test(id)) return null;
  const res = await fetch(`${serverApiUrl()}/api/products/${id}`, { cache: 'no-store' });
  return res.ok ? res.json() : null;
}

async function loadRecommendations(id: string): Promise<Recommendation[]> {
  const res = await fetch(`${serverApiUrl()}/api/products/${id}/recommendations?limit=4`, { cache: 'no-store' }).catch(() => null);
  return res?.ok ? res.json() : [];
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const product = await loadProduct((await params).slug);
  return product ? { title: `${product.title} | Marketplace`, description: product.description } : { title: 'Product Not Found' };
}

async function ProductDetails({ params }: Props) {
  const { slug } = await params;
  const [product, recommendations] = await Promise.all([loadProduct(slug), loadRecommendations(slug)]);
  if (!product) notFound();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    description: product.description,
    sku: product.id,
    brand: product.brand,
    offers: {
      '@type': 'Offer',
      priceCurrency: 'USD',
      price: product.price / 100,
      availability: product.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    },
  };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <nav className="flex items-center text-sm text-muted-foreground mb-6" aria-label="Breadcrumb">
        <Link href="/" className="hover:text-foreground transition-colors">Home</Link>
        <ChevronRight className="w-4 h-4 mx-1" />
        <Link href={`/search?category=${encodeURIComponent(product.category)}`} className="hover:text-foreground transition-colors capitalize">
          {product.category}
        </Link>
        <ChevronRight className="w-4 h-4 mx-1" />
        <span className="text-foreground truncate">{product.title}</span>
      </nav>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-10 mb-16">
        <div className="aspect-square bg-muted rounded-lg overflow-hidden">
          <img src={`https://placehold.co/800x800/png?text=${encodeURIComponent(product.title.slice(0, 20))}`} alt={product.title} className="object-cover w-full h-full" />
        </div>

        <div className="flex flex-col">
          <h1 className="text-3xl font-bold tracking-tight mb-2">{product.title}</h1>
          <div className="text-xl font-semibold mb-4" data-testid="product-price">{formatMoney(product.price)}</div>

          <div className="flex items-center gap-4 mb-6">
            <div className="flex items-center gap-1">
              <Star className="w-5 h-5 fill-primary text-primary" />
              <span className="font-medium">{Number(product.rating).toFixed(1)}</span>
            </div>
            <div className="w-1 h-1 rounded-full bg-border" />
            <span className="font-medium">{product.brand}</span>
          </div>

          <div className="text-sm mb-8">
            {product.inStock ? (
              <span className="text-green-600 font-medium">In Stock ({product.quantity} available)</span>
            ) : (
              <span className="text-destructive font-medium">Out of Stock</span>
            )}
          </div>

          <div className="flex flex-wrap gap-3">
            <AddToCartButton productId={product.id} disabled={!product.inStock} />
            <Button size="lg" variant="outline" asChild>
              <Link href={`/chat?product=${product.id}`}>
                <MessagesSquare className="mr-2 h-4 w-4" /> Chat with seller
              </Link>
            </Button>
          </div>
          <AskProduct productId={product.id} />
        </div>
      </div>

      <Tabs defaultValue="description" className="mb-16">
        <TabsList className="w-full justify-start border-b rounded-none h-auto p-0 bg-transparent">
          <TabsTrigger value="description" className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none py-3">Description</TabsTrigger>
          <TabsTrigger value="discussions" className="rounded-none data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none py-3">Discussions</TabsTrigger>
        </TabsList>
        <TabsContent value="description" className="py-6 prose prose-slate max-w-none">
          <p>{product.description}</p>
        </TabsContent>
        <TabsContent value="discussions" className="py-6">
          <ProductDiscussions productId={product.id} />
        </TabsContent>
      </Tabs>

      {recommendations.length > 0 && (
        <section>
          <h2 className="text-2xl font-bold tracking-tight mb-6">Frequently bought together</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
            {recommendations.map((r) => (
              <ProductCard key={r.productId} {...recommendationToCard(r)} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

export default function ProductPage(props: Props) {
  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <Suspense fallback={<div className="min-h-[60vh] animate-pulse bg-muted/30 rounded-lg" />}>
        <ProductDetails {...props} />
      </Suspense>
    </div>
  );
}
