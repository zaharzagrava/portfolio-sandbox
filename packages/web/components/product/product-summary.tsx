import Link from 'next/link';
import { Star } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ProductPublicView } from '@marketplace-sandbox/contracts';
import { formatMoney } from '@/lib/utils';
import { searchHref } from '@/lib/routes';

/**
 * What the product is and what it costs (W02 FR-052, FR-055): everything the public view carries and nothing it does not
 * (no stock count, no seller id, no view count). Every string from the API is rendered as text. `children` is the
 * purchase area, which sits between the stock line and the shop line (AS-37).
 */
export function ProductSummary({
  product,
  shop,
  children,
}: {
  product: ProductPublicView;
  shop: { name: string } | null;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <h1 className="mb-2 text-3xl font-bold tracking-tight">{product.title}</h1>

      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <p className="flex items-center gap-1">
          <Star aria-hidden="true" className="size-4 fill-primary text-primary" />
          <span>{product.rating > 0 ? `Rated ${product.rating.toFixed(1)} out of 5` : 'Not rated yet'}</span>
        </p>
        {product.brand ? (
          <Link href={searchHref({ brand: product.brand })} className="font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            {product.brand}
          </Link>
        ) : null}
      </div>

      <p className="mb-2 text-2xl font-semibold" data-testid="product-price">
        {formatMoney(product.priceMinor, product.currency)}
      </p>
      <p className={product.inStock ? 'mb-6 text-sm font-medium text-green-700 dark:text-green-500' : 'mb-6 text-sm font-medium text-destructive'}>
        {product.inStock ? 'In stock' : 'Out of stock'}
      </p>

      {children}

      {shop ? <p className="mt-6 text-sm text-muted-foreground">{`Sold by ${shop.name}`}</p> : null}

      {product.description ? (
        <p className="mt-6 whitespace-pre-line" data-testid="product-description">
          {product.description}
        </p>
      ) : null}

      {product.tags.length > 0 ? (
        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Tags">
          {product.tags.map((tag) => (
            <li key={tag}>
              <Link
                href={searchHref({ q: tag })}
                className="inline-flex min-h-8 items-center rounded-full border px-3 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring max-sm:min-h-11"
              >
                {tag}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
