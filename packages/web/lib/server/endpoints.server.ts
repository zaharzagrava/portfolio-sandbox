import 'server-only';
import { config } from '@/lib/config';

/**
 * The only readers of the service addresses (W02 FR-152, gaps A6): `API_URL`, `BFF_URL` and `SITE_URL` never reach a module
 * that a client component can import. Server Components and `lib/server/*.server.ts` call these.
 */

/** Core API base URL, for server-side reads (the browser uses relative `/api/...`). */
export const apiUrl = (): string => config.apiUrl;

/** BFF base URL: the product-page aggregate, the session lookup. */
export const bffUrl = (): string => config.bffUrl;

/** The storefront's own origin: canonical links, share destinations, structured data. */
export const siteUrl = (): string => config.siteUrl;
