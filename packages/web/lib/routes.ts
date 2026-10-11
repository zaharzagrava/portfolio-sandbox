import { loginHref } from '@/lib/auth/return-to';
import { parseSearchView, toSearchParams, type SearchView } from '@/lib/search/search-view';

/** `/products/{productId}`: the one place a product address is built (W02 contract; W03 and W07 import it). */
export const productHref = (productId: string): string => `/products/${encodeURIComponent(productId)}`;

/** W03 route builders: the one place the cart, checkout and order addresses are made. */
export const cartHref = (): string => '/cart';
export const checkoutHref = (): string => '/checkout';
export const payHref = (orderId: string): string => `/checkout/pay/${encodeURIComponent(orderId)}`;
export const successHref = (orderId: string): string => `/checkout/success/${encodeURIComponent(orderId)}`;
export const ordersHref = (cursor?: string): string => (cursor ? `/orders?cursor=${encodeURIComponent(cursor)}` : '/orders');
export const orderHref = (orderId: string): string => `/orders/${encodeURIComponent(orderId)}`;

/** The canonical `/search?…` of a view; invalid parts are cleaned the way the address parser does. */
export function searchHref(view: Partial<SearchView> = {}): string {
  const raw: Record<string, string> = {};
  for (const [name, value] of Object.entries(view)) if (value !== undefined) raw[name] = String(value);
  const query = toSearchParams(parseSearchView(raw).view).toString();
  return query ? `/search?${query}` : '/search';
}

/** Sign-in link that returns to `returnTo` (a same-site path), through W01's `loginHref`. */
export const signInHref = (returnTo: string): string => loginHref(returnTo);
