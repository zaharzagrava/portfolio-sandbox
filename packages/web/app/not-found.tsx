import type { Metadata } from 'next';
import { NotFoundState } from '@/components/layout/system-states';

// The title template of the root layout adds " · Marketplace". Next.js itself adds `noindex` to a not-found response.
// The visited path is never shown (it may hold a token).
export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return <NotFoundState />;
}
