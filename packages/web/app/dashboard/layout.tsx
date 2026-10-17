import type { ReactNode } from 'react';

/**
 * Passes its children through (W04 FR-013). The seller frame lives in `seller/[shopId]/layout.tsx`, where the shop is known;
 * `/dashboard` and `/dashboard/settings` only redirect.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return children;
}
