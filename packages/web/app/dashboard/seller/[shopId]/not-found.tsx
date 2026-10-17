import type { Metadata } from 'next';
import { ShopNotFound } from '@/components/seller/shop-not-found';

export const metadata: Metadata = { title: 'Shop not found', robots: { index: false, follow: false } };

export default function NotFound() {
  return <ShopNotFound />;
}
