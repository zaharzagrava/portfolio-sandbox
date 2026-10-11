import { SearchShellSkeleton } from '@/components/search/search-skeleton';

/** The search shell while the page streams: the same grid as the final page, so nothing jumps (W02 FR-037). */
export default function SearchLoading() {
  return <SearchShellSkeleton />;
}
