import { OverviewSkeleton } from '@/components/seller/page-skeletons';

/** The default content skeleton of a shop page while it streams; routes with another layout add their own `loading.tsx`. */
export default function Loading() {
  return <OverviewSkeleton />;
}
