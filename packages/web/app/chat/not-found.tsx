import type { Metadata } from 'next';
import { NotFoundState } from '@/components/layout/system-states';

// The visited address is never shown (it may hold an id). Next.js adds `noindex` to a not-found response.
export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return <NotFoundState />;
}
