import type { Metadata } from 'next';
import { ShopNotFound } from '@/components/seller/shop-not-found';

export const metadata: Metadata = { title: 'Shop not found', robots: { index: false, follow: false } };

/** `[shopId]/layout.tsx` throws `notFound()` itself, which only the segment above can catch (W04 AS-85). */
export default function NotFound() {
  return <ShopNotFound />;
}
