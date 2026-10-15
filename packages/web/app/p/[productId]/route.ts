import { notFound } from 'next/navigation';
import { isProductId } from '@/lib/product/ids';
import { productHref } from '@/lib/routes';

/**
 * `/p/{productId}` is the short address that share links and ad clicks use (W02 FR-125): a permanent redirect (308) to
 * `/products/{productId}` with the query kept (`ref`, `ad`, ...). An id that is not a UUID is not a product.
 *
 * A Route Handler, not a page: the root layout streams, so a page's `permanentRedirect()` would arrive after the 200 status
 * was sent and reach the browser as a client-side redirect (and crawlers, curl and the ad click check would see no redirect).
 * The address is relative, so it stays on the host that was asked.
 */
async function redirectToProduct(request: Request, { params }: { params: Promise<{ productId: string }> }): Promise<Response> {
  const { productId } = await params;
  if (!isProductId(productId)) notFound();
  const { search } = new URL(request.url);
  return new Response(null, { status: 308, headers: { Location: `${productHref(productId)}${search}` } });
}

export const GET = redirectToProduct;
export const HEAD = redirectToProduct;
