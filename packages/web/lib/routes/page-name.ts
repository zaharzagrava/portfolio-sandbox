/**
 * The name a page view is reported under (AS-35): the route template, never the address. A static list, so an invite
 * token, an order id or a query string cannot reach analytics; the test `page-name.test.ts` fails when a page under
 * `app/` has no entry here.
 */
export const PAGE_TEMPLATES = [
  '/',
  '/account/notifications',
  '/account/security',
  '/admin/feature-flags',
  '/admin/feature-flags/new',
  '/admin/feature-flags/:key',
  '/cart',
  '/chat',
  '/checkout',
  '/checkout/pay/:orderId',
  '/checkout/success/:orderId',
  '/dashboard',
  '/dashboard/orders',
  '/dashboard/seller',
  '/dashboard/seller/inventory',
  '/dashboard/seller/:shopId/orders',
  '/dashboard/seller/:shopId',
  '/dashboard/seller/:shopId/inventory',
  '/dashboard/settings',
  '/dashboard/seller/:shopId/payouts',
  '/dashboard/seller/:shopId/statements',
  '/dashboard/seller/:shopId/imports',
  '/dashboard/seller/:shopId/exports',
  '/dashboard/seller/:shopId/team',
  '/dashboard/seller/:shopId/campaigns',
  '/dashboard/seller/:shopId/widget',
  '/dashboard/seller/:shopId/knowledge',
  '/dashboard/seller/:shopId/developers/api-keys',
  '/dashboard/seller/:shopId/developers/webhooks',
  '/dashboard/seller/:shopId/developers/webhooks/:endpointId',
  '/dashboard/seller/:shopId/developers/api-version',
  '/dashboard/integrations',
  '/dashboard/seller/:shopId/integrations',
  '/dashboard/seller/:shopId/integrations/:integrationId',
  '/dashboard/seller/:shopId/integrations/offline-conflicts',
  '/dashboard/seller/:shopId/products/:productId/draft',
  '/dashboard/seller/:shopId/products/:productId/media',
  '/dashboard/seller/:shopId/products/:productId/media/video',
  '/dashboard/seller/:shopId/developers/logs',
  '/dashboard/seller/:shopId/developers/usage',
  '/developers/docs',
  '/forgot-password',
  '/invites/:token',
  '/login',
  '/login/mfa',
  '/orders',
  '/orders/:orderId',
  '/p/:productId',
  '/privacy',
  '/products/:slug',
  '/register',
  '/reset-password',
  '/search',
  '/terms',
  '/unsubscribe',
] as const;

export const NOT_FOUND_PAGE = '/not-found';
export const ERROR_PAGE = '/error';
const MAX_PAGE = 500;

const SEGMENTED = PAGE_TEMPLATES.map((template) => ({ template, segments: template.split('/').filter(Boolean) }));

function matchTemplate(pathname: string): string | undefined {
  const path = pathname.split('#')[0].split('?')[0];
  const segments = path.split('/').filter(Boolean);
  return SEGMENTED.find(
    (candidate) =>
      candidate.segments.length === segments.length &&
      candidate.segments.every((part, index) => part.startsWith(':') || part === segments[index]),
  )?.template;
}

/**
 * `matchedTemplate` is what the router says it matched; it is used only when it is one of the listed templates (or the
 * root-error name), otherwise the pathname is matched here. Anything unmatched is `/not-found`.
 */
export function pageNameFor(pathname: string, matchedTemplate?: string): string {
  const listed = matchedTemplate === ERROR_PAGE || (PAGE_TEMPLATES as readonly string[]).includes(matchedTemplate ?? '');
  const name = listed ? (matchedTemplate as string) : (matchTemplate(pathname) ?? NOT_FOUND_PAGE);
  return name.slice(0, MAX_PAGE);
}
