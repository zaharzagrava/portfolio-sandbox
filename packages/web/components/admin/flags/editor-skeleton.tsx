import { Skeleton } from '@/components/ui/skeleton';

/** Header, sections and help card shaped like the loaded editor: no text, no spinner (W06 AS-63). Server-safe. */
export function EditorSkeleton() {
  return (
    <div aria-hidden="true" data-skeleton="editor" className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Skeleton className="h-56 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
        <Skeleton className="hidden h-32 w-full rounded-xl lg:block" />
      </div>
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}
