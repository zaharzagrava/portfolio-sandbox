'use client';

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PostView, TopWindow } from '@marketplace-sandbox/contracts';
import type { DiscussionWindow } from '@/lib/product/page-view';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { listPosts } from '@/lib/api/discussions';
import { problemFromError } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';
import { queryKeys } from '@/lib/query-keys';
import type { DiscussionSort } from '@/lib/product/page-view';
import { DiscussionPost } from './discussion-post';
import { ReadProblem } from './read-problem';
import { useDiscussionsView } from './use-discussions-view';

const SORTS: { value: DiscussionSort; label: string }[] = [
  { value: 'hot', label: 'Hot' },
  { value: 'top', label: 'Top' },
  { value: 'new', label: 'New' },
];
const WINDOWS: { value: TopWindow; label: string }[] = [
  { value: 'day', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: 'year', label: 'This year' },
  { value: 'all', label: 'All time' },
];
const EMPTY = 'No discussions yet. Be the first to ask.';
const DEGRADED = 'Showing a reduced list. Some discussions may be missing.';
/** A deep link to a post that is not on the first page walks the pages for it, up to this many. */
const MAX_PAGES_FOR_DEEP_LINK = 5;

/**
 * The board of a product as a list (W02 AS-45, AS-52, AS-53, FR-081): the sort and time window live in the address, the
 * posts are an infinite query under `queryKeys.discussions.board(productId, {sort, window})` merged and de-duplicated by
 * `postId`, and every failure is shown beside the list while the posts already loaded stay.
 */
export function DiscussionList({
  productId,
  announce,
  focusPostId,
  onFocused,
}: {
  productId: string;
  announce: (text: string) => void;
  /** A post that was just created: its title takes focus once it is in the list. */
  focusPostId?: string;
  onFocused?: () => void;
}) {
  const client = useQueryClient();
  const { view, change } = useDiscussionsView();
  const window_: TopWindow | undefined = view.sort === 'top' ? (view.window ?? 'all') : undefined;
  const key = queryKeys.discussions.board(productId, { sort: view.sort, ...(window_ ? { window: window_ } : {}) });

  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => listPosts(productId, { sort: view.sort, window: window_, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const posts = useMemo(() => {
    const seen = new Set<string>();
    const unique: PostView[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const post of page.items) {
        if (seen.has(post.postId)) continue;
        seen.add(post.postId);
        unique.push(post);
      }
    }
    return unique;
  }, [query.data]);
  const degraded = query.data?.pages.some((page) => page.degraded === true) ?? false;
  const problem = query.isError ? problemFromError(query.error) : undefined;

  // Titles, for moving focus: after **Show more discussions**, after Post, and for a deep link.
  const titles = useRef(new Map<string, HTMLElement>());
  const region = useRef<HTMLDivElement>(null);
  const registerTitle = useCallback(
    (postId: string) => (node: HTMLElement | null) => {
      if (node) titles.current.set(postId, node);
      else titles.current.delete(postId);
    },
    [],
  );

  const focusAfter = useRef<number | null>(null);
  useEffect(() => {
    if (focusAfter.current === null || posts.length <= focusAfter.current) return;
    const added = posts[focusAfter.current];
    focusAfter.current = null;
    if (added) titles.current.get(added.postId)?.focus();
  }, [posts]);

  useEffect(() => {
    if (!focusPostId) return;
    const title = titles.current.get(focusPostId);
    if (!title) return;
    title.focus();
    onFocused?.();
  }, [focusPostId, posts, onFocused]);

  // A deep link opens its post, scrolled into view with focus on its title; an id that is not in the board is dropped.
  const deepLink = useRef(view.post);
  const wanted = view.post;
  const pagesLoaded = query.data?.pages.length ?? 0;
  const { fetchNextPage, hasNextPage, isFetching } = query;
  useEffect(() => {
    if (!wanted || query.isPending || isFetching) return;
    if (posts.some((post) => post.postId === wanted)) {
      if (deepLink.current === wanted) {
        deepLink.current = undefined;
        const title = titles.current.get(wanted);
        title?.focus();
        title?.scrollIntoView?.({ block: 'start' });
      }
      return;
    }
    if (hasNextPage && !query.isError && pagesLoaded < MAX_PAGES_FOR_DEEP_LINK) void fetchNextPage();
    else if (!hasNextPage || pagesLoaded >= MAX_PAGES_FOR_DEEP_LINK) change({ post: null }, 'replace');
  }, [wanted, posts, query.isPending, query.isError, isFetching, hasNextPage, pagesLoaded, fetchNextPage, change]);

  // `invalid_cursor`: the page asked for is gone, so start again from the first page and say so (for this view only).
  const [notice, setNotice] = useState<{ view: string; text: string } | null>(null);
  const viewKey = JSON.stringify(key);
  async function loadNext(): Promise<void> {
    const result = await query.fetchNextPage();
    if (!result.isError) return;
    const failure = problemFromError(result.error);
    if (failure.code !== 'invalid_cursor') return;
    setNotice({ view: viewKey, text: problemCopy('discussions-read', failure).text });
    await client.resetQueries({ queryKey: key });
  }

  const showMore = () => {
    focusAfter.current = posts.length;
    void loadNext();
  };

  const visibleProblem = problem;

  return (
    <div ref={region} tabIndex={-1} className="space-y-4 outline-none" aria-busy={query.isFetching && !query.isFetchingNextPage}>
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Sort discussions" className="flex gap-1">
          {SORTS.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={view.sort === option.value ? 'secondary' : 'outline'}
              className="max-sm:min-h-11"
              aria-pressed={view.sort === option.value}
              onClick={() => change({ sort: option.value })}
            >
              {option.label}
            </Button>
          ))}
        </div>
        {view.sort === 'top' ? (
          <label className="flex items-center gap-2 text-sm">
            Time
            <select
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm max-sm:h-11"
              value={window_}
              onChange={(event) => change({ window: event.target.value === 'all' ? null : (event.target.value as DiscussionWindow) })}
            >
              {WINDOWS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {notice && notice.view === viewKey ? (
        <p role="status" className="rounded-lg border px-3 py-2 text-sm">
          {notice.text}
        </p>
      ) : null}
      {degraded ? (
        <p role="status" className="rounded-lg border px-3 py-2 text-sm">
          {DEGRADED}
        </p>
      ) : null}

      {query.isPending && !visibleProblem ? (
        <>
          <p role="status" className="sr-only">
            Loading discussions…
          </p>
          <div data-testid="discussion-skeleton" className="space-y-4" aria-hidden="true">
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        </>
      ) : null}

      {visibleProblem && posts.length === 0 ? (
        <ReadProblem problem={visibleProblem} retry={() => void query.refetch()} busy={query.isFetching} />
      ) : null}

      {!query.isPending && !problem && posts.length === 0 ? <p className="text-sm">{EMPTY}</p> : null}

      {posts.length > 0 ? (
        <div className="space-y-4">
          {posts.map((post) => (
            <DiscussionPost
              key={post.postId}
              post={post}
              expanded={view.post === post.postId}
              onToggle={() => change({ post: view.post === post.postId ? null : post.postId })}
              announce={announce}
              titleRef={registerTitle(post.postId)}
              onRemoved={() => region.current?.focus()}
            />
          ))}
        </div>
      ) : null}

      {visibleProblem && posts.length > 0 ? (
        <ReadProblem problem={visibleProblem} retry={() => void loadNext()} busy={query.isFetching} />
      ) : null}
      {query.hasNextPage && !visibleProblem ? (
        <Button type="button" variant="outline" className="min-h-9 max-sm:min-h-11" disabled={query.isFetchingNextPage} onClick={showMore}>
          Show more discussions
        </Button>
      ) : null}
    </div>
  );
}
