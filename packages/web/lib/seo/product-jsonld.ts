import type { ProductPublicView } from '@marketplace-sandbox/contracts';
import { currencyDigits } from '@/lib/search/price-input';
import { productHref } from '@/lib/routes';

/**
 * The `Product` structured data of a product page (W02 FR-053): the same fields as the visible page, the currency of the
 * response, and every `<` written as `<`, so no title or description can close the script element (AS-72).
 */
export function productJsonLd(product: ProductPublicView, options: { siteUrl: string; imageUrl?: string }): string {
  const digits = currencyDigits(product.currency);
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    description: product.description,
    sku: product.id,
    brand: { '@type': 'Brand', name: product.brand },
    ...(options.imageUrl ? { image: [options.imageUrl] } : {}),
    url: `${options.siteUrl.replace(/\/$/, '')}${productHref(product.id)}`,
    offers: {
      '@type': 'Offer',
      priceCurrency: product.currency,
      price: (product.priceMinor / 10 ** digits).toFixed(digits),
      availability: product.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    },
  };
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
