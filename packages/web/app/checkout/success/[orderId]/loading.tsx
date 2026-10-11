import { SuccessSkeleton } from '@/components/checkout/page-skeletons';

export default function Loading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 md:px-6">
      <SuccessSkeleton />
    </div>
  );
}
