import 'server-only';
import { notFound, redirect } from 'next/navigation';
import type { OrderPageResponse } from '@marketplace-sandbox/contracts';
import { loginHref } from '@/lib/auth/return-to';
import { requireServerSession } from '@/lib/auth/session.server';
import { isOrderId } from '@/lib/checkout/order-id';
import { getOrderAggregate } from '@/lib/server/orders.server';

/**
 * The guard and the first read of a page about one of the member's orders (W03 AS-35, AS-50, FR-010): the pay and the
 * success page. Call it inside `<Suspense>`: it reads the request's cookies.
 *
 * - a malformed id is not an order: not found, nothing is read;
 * - an anonymous visitor goes to sign-in with `returnTo`, before any member data is read;
 * - an unknown order and another member's order are the same `404`: not found, never a 403 form;
 * - a session that ended between the guard and the read goes to sign-in too;
 * - any other failure returns `null`: the browser reads the order again and shows its own error with Try again.
 */
export async function readGuardedOrder(orderId: string, returnTo: string): Promise<OrderPageResponse | null> {
  if (!isOrderId(orderId)) notFound();
  await requireServerSession(returnTo);
  const read = await getOrderAggregate(orderId);
  if (read.ok) return read.data;
  if (read.status === 404) notFound();
  if (read.status === 401) redirect(loginHref(returnTo));
  return null;
}
