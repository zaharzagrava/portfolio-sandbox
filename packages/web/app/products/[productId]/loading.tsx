import { ProductSkeleton } from '@/components/product/product-skeleton';

export default function ProductLoading() {
  return (
    <div className="container mx-auto max-w-7xl px-4 py-8">
      <ProductSkeleton />
    </div>
  );
}
