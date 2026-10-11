import { PaySkeleton } from '@/components/checkout/page-skeletons';

export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6">
      <PaySkeleton />
    </div>
  );
}
