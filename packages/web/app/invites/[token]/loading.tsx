import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Skeleton aria-hidden="true" className="h-40 w-full" />
    </div>
  );
}
