import { ReviewSkeleton } from '@/components/checkout/review-skeleton';

export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6">
      <ReviewSkeleton />
    </div>
  );
}
