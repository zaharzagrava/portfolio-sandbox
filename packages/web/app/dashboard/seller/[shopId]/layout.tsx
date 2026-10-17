import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import { ShellSkeleton } from '@/components/dashboard/shell-skeleton';
import { ShopFrame } from '@/components/dashboard/shop-frame';

export const metadata: Metadata = { title: 'Seller dashboard', robots: { index: false, follow: false } };

/**
 * Every `/dashboard/seller/{shopId}/**` page (W04 FR-001, FR-002): the session and the shop are read inside `ShopFrame`,
 * behind Suspense, never at the top of the layout. An anonymous visitor is redirected, a malformed, unknown or foreign shop
 * is the not-found page, and nothing here is cached (per-member data).
 */
export default function ShopLayout({ children, params }: { children: ReactNode; params: Promise<{ shopId: string }> }) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <ShopFrame params={params}>{children}</ShopFrame>
    </Suspense>
  );
}
