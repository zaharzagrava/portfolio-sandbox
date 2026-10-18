import { Skeleton } from '@/components/ui/skeleton';

/** The page frame of `/chat`: its height is the viewport below the 3.5 rem header, on a phone and on a desktop (W05 AS-37, AS-38). */
export const CHAT_FRAME = 'mx-auto flex h-[calc(100dvh-3.5rem)] w-full max-w-7xl min-h-0 flex-col overflow-hidden lg:border-x';

/** The static shell shown while the guard and the first inbox page load (also `app/chat/loading.tsx`). */
export function ChatSkeleton() {
  return (
    <div className={CHAT_FRAME}>
      <div role="status" className="flex min-h-0 w-full flex-1">
        <span className="sr-only">Loading chats…</span>
        <div aria-hidden="true" className="flex w-full flex-col divide-y lg:w-80 lg:shrink-0 lg:border-r">
          {['a', 'b', 'c', 'd'].map((key) => (
            <div key={key} className="flex min-h-14 items-center gap-3 px-3 py-2">
              <Skeleton className="h-4 flex-1 motion-reduce:animate-none" />
              <Skeleton className="h-4 w-8 motion-reduce:animate-none" />
            </div>
          ))}
        </div>
        <div aria-hidden="true" className="hidden flex-1 p-6 lg:block">
          <Skeleton className="h-6 w-1/3 motion-reduce:animate-none" />
        </div>
      </div>
    </div>
  );
}
