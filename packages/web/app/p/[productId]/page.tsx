import { notFound, permanentRedirect } from 'next/navigation';
import { isProductId } from '@/lib/product/ids';
import { productHref } from '@/lib/routes';

/**
 * `/p/{productId}` is the short address that share links and ad clicks use (W02 FR-125): a permanent redirect to
 * `/products/{productId}` with the query kept (`ref`, `ad`, …). An id that is not a UUID is not a product.
 */
export default async function ShortProductLink({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { productId } = await params;
  if (!isProductId(productId)) notFound();

  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(await searchParams)) {
    if (typeof value === 'string') query.append(name, value);
    else if (Array.isArray(value)) for (const item of value) query.append(name, item);
  }
  const text = query.toString();
  permanentRedirect(`${productHref(productId)}${text ? `?${text}` : ''}`);
}
