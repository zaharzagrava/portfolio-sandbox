import { Skeleton } from "@/components/ui/skeleton"

export default function ProductLoading() {
  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      <div className="mb-6 flex gap-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-4" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-4" />
        <Skeleton className="h-4 w-32" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-10 mb-16">
        <div className="space-y-4">
          <Skeleton className="aspect-square w-full rounded-lg" />
          <div className="grid grid-cols-4 gap-4">
            <Skeleton className="aspect-square w-full rounded-md" />
            <Skeleton className="aspect-square w-full rounded-md" />
            <Skeleton className="aspect-square w-full rounded-md" />
            <Skeleton className="aspect-square w-full rounded-md" />
          </div>
        </div>

        <div className="flex flex-col">
          <Skeleton className="h-10 w-3/4 mb-4" />
          <Skeleton className="h-6 w-24 mb-6" />
          
          <div className="flex items-center gap-4 mb-6">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-4 w-48 mb-8" />
          
          <Skeleton className="h-12 w-32 mb-4" />
          <Skeleton className="h-24 w-full mt-4" />

          <div className="space-y-2 mt-8">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        </div>
      </div>
    </div>
  )
}
