import { PageSkeleton } from '@/components/layout/page-skeleton';

/**
 * Placeholder while a route streams in. Server Component: the 150 ms "no flash" delay is a CSS animation delay
 * (`.loading-reveal`, globals.css), so it also holds in HTML that streams before any script runs.
 */
export default function Loading() {
  return (
    // At least one viewport tall, so the footer stays below the fold while a long page streams in (it would otherwise be
    // visible under the short placeholder and jump out of view: a layout shift).
    <div aria-busy="true" className="min-h-svh">
      <div data-reveal-delay className="loading-reveal" style={{ animationDelay: '150ms', animationFillMode: 'both' }}>
        <span role="status" className="sr-only">
          Loading…
        </span>
        <PageSkeleton variant="detail" />
      </div>
    </div>
  );
}
