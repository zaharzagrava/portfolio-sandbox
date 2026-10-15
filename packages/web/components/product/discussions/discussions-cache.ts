import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import type { CommentNode, CommentView, PostView } from '@marketplace-sandbox/contracts';
import { queryKeys } from '@/lib/query-keys';

/**
 * Edits of the discussion queries held by TanStack Query (W02 FR-085, FR-086): a vote, a new comment, a delete or a
 * vanished item changes the cached post or comment in place instead of refetching the list. Everything lives under the
 * `['discussions', 'board' | 'thread' | 'replies', ...]` keys of `lib/query-keys.ts`; each is an infinite query of pages
 * `{items, nextCursor}`.
 */

export type Item = PostView | CommentView | CommentNode;
type Page = { items: Item[]; nextCursor: string | null; degraded?: true };
type Data = InfiniteData<Page, unknown>;

const ROOT = ['discussions'] as const;

/** The id of a post or comment: a comment also carries its `postId`, so `commentId` decides. */
export const itemId = (item: Item): string => ('commentId' in item ? item.commentId : item.postId);

const isNode = (item: Item): item is CommentNode => 'replies' in item;

function entries(client: QueryClient): [QueryKey, Data][] {
  return client
    .getQueriesData<Data>({ queryKey: ROOT })
    .filter((entry): entry is [QueryKey, Data] => Boolean(entry[1] && Array.isArray(entry[1].pages)));
}

/** Rewrites every cached page; a query whose pages come out unchanged is left as it is. */
function rewrite(client: QueryClient, map: (items: Item[], kind: string) => Item[]): void {
  for (const [key, data] of entries(client)) {
    const kind = String(key[1]);
    let changed = false;
    const pages = data.pages.map((page) => {
      const items = map(page.items, kind);
      if (items === page.items) return page;
      changed = true;
      return { ...page, items };
    });
    if (!changed) continue;
    client.setQueryData<Data>(key, { ...data, pages });
  }
}

/** Applies `update` to the post or comment `id` wherever it is cached (also as an embedded reply). */
export function updateTarget<T extends Item>(client: QueryClient, id: string, update: (item: T) => T): void {
  const apply = update as unknown as (item: Item) => Item;
  const patch = (items: Item[]): Item[] => {
    let changed = false;
    const next = items.map((item) => {
      let current = item;
      if (isNode(current) && current.replies.some((reply) => reply.commentId === id)) {
        current = { ...current, replies: current.replies.map((reply) => (reply.commentId === id ? (apply(reply) as CommentView) : reply)) };
      }
      if (itemId(current) === id) current = apply(current);
      if (current !== item) changed = true;
      return current;
    });
    return changed ? next : items;
  };
  rewrite(client, patch);
}

/** Takes a post out of every cached board. */
export function removePost(client: QueryClient, postId: string): void {
  rewrite(client, (items, kind) => {
    if (kind !== 'board') return items;
    const next = items.filter((item) => itemId(item) !== postId);
    return next.length === items.length ? items : next;
  });
}

/** Takes a comment out of every cached thread and replies list (a vanished comment). */
export function removeComment(client: QueryClient, commentId: string): void {
  rewrite(client, (items, kind) => {
    if (kind === 'board') return items;
    const next = items
      .filter((item) => itemId(item) !== commentId)
      .map((item) => (isNode(item) && item.replies.some((reply) => reply.commentId === commentId) ? { ...item, replies: item.replies.filter((reply) => reply.commentId !== commentId) } : item));
    return next.length === items.length && next.every((item, index) => item === items[index]) ? items : next;
  });
}

export const bumpCommentCount = (client: QueryClient, postId: string, by = 1): void =>
  updateTarget<PostView>(client, postId, (post) => ({ ...post, commentCount: Math.max(0, post.commentCount + by) }));

/** Cached comment sorted for the first page of a thread: where a new top-level comment belongs. */
export function insertTopLevelComment(client: QueryClient, comment: CommentView, sort: string): void {
  const key = queryKeys.discussions.thread(comment.postId, sort);
  // A read that is still in flight started before this comment existed: its answer would not list it (or would replace the
  // copy placed below), so it is cancelled and the thread is read again.
  if (client.isFetching({ queryKey: key }) > 0) {
    void client.invalidateQueries({ queryKey: key });
    return;
  }
  const data = client.getQueryData<Data>(key);
  if (!data?.pages.length) return;
  const node: CommentNode = { ...comment, replies: [], hasMoreReplies: false };
  const seen = data.pages.some((page) => page.items.some((item) => itemId(item) === comment.commentId));
  if (seen) return;
  const pages = [...data.pages];
  if (sort === 'old') {
    const last = pages.length - 1;
    if (pages[last]!.nextCursor !== null) return; // the oldest-first end is not loaded yet; the next page brings it
    pages[last] = { ...pages[last]!, items: [...pages[last]!.items, node] };
  } else {
    pages[0] = { ...pages[0]!, items: [node, ...pages[0]!.items] };
  }
  client.setQueryData<Data>(key, { ...data, pages });
}

/**
 * Puts a new reply under its parent. A parent that is a top-level comment of a cached thread takes it into `replies`; a
 * deeper parent takes it into its replies query. Returns `false` when the parent has replies that are not loaded (its list
 * must be fetched instead of guessed), `true` when the reply is in place.
 */
export function insertReply(client: QueryClient, reply: CommentView, parent: CommentView): boolean {
  let placed = false;
  rewrite(client, (items, kind) => {
    if (kind !== 'thread') return items;
    let changed = false;
    const next = items.map((item) => {
      if (!isNode(item) || item.commentId !== parent.commentId) return item;
      if (item.replies.some((existing) => existing.commentId === reply.commentId)) {
        placed = true;
        return item;
      }
      changed = true;
      placed = true;
      return { ...item, replies: [...item.replies, reply], replyCount: item.replyCount + 1 };
    });
    return changed ? next : items;
  });
  if (placed) return true;

  const key = queryKeys.discussions.replies(parent.commentId);
  const data = client.getQueryData<Data>(key);
  let inPlace = true;
  if (data?.pages.length) {
    const pages = [...data.pages];
    const last = pages.length - 1;
    if (!pages[last]!.items.some((item) => itemId(item) === reply.commentId)) {
      pages[last] = { ...pages[last]!, items: [...pages[last]!.items, reply] };
      client.setQueryData<Data>(key, { ...data, pages });
    }
  } else if (parent.replyCount === 0) {
    client.setQueryData<Data>(key, { pages: [{ items: [reply], nextCursor: null }], pageParams: [undefined] });
  } else {
    inPlace = false;
  }
  updateTarget<CommentView>(client, parent.commentId, (item) => ({ ...item, replyCount: item.replyCount + 1 }));
  return inPlace;
}
