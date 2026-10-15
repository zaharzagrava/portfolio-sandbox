'use client';

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CommentNode, CommentView, PostView } from '@marketplace-sandbox/contracts';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { listComments, listReplies, REPLIES_PAGE_SIZE, type ThreadSort } from '@/lib/api/discussions';
import { problemFromError } from '@/lib/api/errors';
import { formatDiscussionTime } from '@/lib/discussions-time';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { CommentForm } from './comment-form';
import { DeleteDialog } from './delete-dialog';
import { bumpCommentCount, insertReply, insertTopLevelComment } from './discussions-cache';
import { ReadProblem } from './read-problem';
import { SafeBody } from './safe-body';
import { VoteButtons } from './vote-buttons';

const SORTS: { value: ThreadSort; label: string }[] = [
  { value: 'best', label: 'Best' },
  { value: 'new', label: 'New' },
  { value: 'old', label: 'Old' },
];

/** The deepest comment that still has a Reply control (W02 AS-49: none at depth 8). */
const MAX_REPLY_DEPTH = 7;
/** Replies of a comment this deep or deeper are not indented further at 640 px and below. */
const INDENT_CAP_DEPTH = 3;
const DEGRADED = 'Showing a reduced list. Some discussions may be missing.';

function unique<T extends { commentId: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.commentId) ? false : (seen.add(item.commentId), true)));
}

type Shared = {
  postId: string;
  announce: (text: string) => void;
  /** Registers a comment's article so focus can be moved to it. */
  register: (commentId: string) => (node: HTMLElement | null) => void;
  focusComment: (commentId: string) => void;
};

const NONE: CommentView[] = [];

function CommentItem({
  comment,
  embedded = NONE,
  hasMoreEmbedded,
  shared,
}: {
  comment: CommentView;
  embedded?: CommentView[];
  hasMoreEmbedded?: boolean;
  shared: Shared;
}) {
  const client = useQueryClient();
  const { user } = useAuth();
  const [requested, setRequested] = useState(false);
  const [replying, setReplying] = useState(false);
  const article = useRef<HTMLElement | null>(null);
  const { register } = shared;

  const replies = useInfiniteQuery({
    queryKey: queryKeys.discussions.replies(comment.commentId),
    queryFn: ({ pageParam, signal }) =>
      listReplies(
        comment.commentId,
        // The first request starts at the beginning, so it asks for the embedded replies again plus the next five.
        pageParam ? { limit: REPLIES_PAGE_SIZE, cursor: pageParam } : { limit: Math.min(50, embedded.length + REPLIES_PAGE_SIZE) },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: requested,
  });

  const children = useMemo(
    () => unique([...embedded, ...(replies.data?.pages.flatMap((page) => page.items) ?? [])]),
    [embedded, replies.data],
  );
  const remaining = Math.max(1, comment.replyCount - children.length);
  const hasMore = replies.data
    ? replies.hasNextPage
    : (hasMoreEmbedded ?? comment.replyCount > children.length);

  // **Show more replies** moves focus to the first reply it added.
  const focusAfter = useRef<number | null>(null);
  const { focusComment } = shared;
  useEffect(() => {
    if (focusAfter.current === null || children.length <= focusAfter.current) return;
    const first = children[focusAfter.current];
    focusAfter.current = null;
    if (first) focusComment(first.commentId);
  }, [children, focusComment]);

  const showMore = () => {
    focusAfter.current = children.length;
    if (requested) void replies.fetchNextPage();
    else setRequested(true);
  };

  const tombstone = comment.deleted;
  const mine = user !== null && comment.authorId !== null && comment.authorId.toLowerCase() === user.id.toLowerCase();
  const time = formatDiscussionTime(comment.createdAt);
  const problem = replies.isError ? problemFromError(replies.error) : undefined;

  return (
    <article ref={(node) => { article.current = node; register(comment.commentId)(node); }} tabIndex={-1} data-comment="" className="space-y-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {tombstone ? (
        <p className="text-sm italic text-muted-foreground">
          {comment.deletedBy === 'moderator' ? 'Comment removed by a moderator.' : 'Comment deleted by its author.'}
        </p>
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>{mine ? 'You' : 'Community member'}</span>
            <time dateTime={time.dateTime} title={time.title}>
              {time.text}
            </time>
          </p>
          <SafeBody html={comment.bodyHtml} />
          <div className="flex flex-wrap items-start gap-2">
            <VoteButtons
              target={{ id: comment.commentId, kind: 'comment', authorId: comment.authorId, name: 'comment' }}
              votes={{ ups: comment.ups, downs: comment.downs, score: comment.score, myVote: comment.myVote }}
              announce={shared.announce}
              inline
            />
            {user && comment.depth <= MAX_REPLY_DEPTH ? (
              <Button type="button" variant="ghost" size="sm" className="max-sm:min-h-11" aria-expanded={replying} aria-label="Reply to comment" onClick={() => setReplying((open) => !open)}>
                Reply
              </Button>
            ) : null}
            <DeleteDialog
              kind="comment"
              id={comment.commentId}
              authorId={comment.authorId}
              name="comment"
              announce={shared.announce}
              onDeleted={() => article.current?.focus()}
            />
          </div>
        </>
      )}

      {replying ? (
        <div className="pl-3">
          <CommentForm
            postId={shared.postId}
            parent={comment}
            autoFocus
            announce={shared.announce}
            onCancel={() => setReplying(false)}
            onCreated={(reply) => {
              const placed = insertReply(client, reply, comment);
              bumpCommentCount(client, shared.postId);
              setReplying(false);
              if (!placed) setRequested(true);
              shared.focusComment(reply.commentId);
            }}
          />
        </div>
      ) : null}

      {children.length > 0 ? (
        <div
          data-replies=""
          className={cn(
            'space-y-3 border-l pl-3 sm:pl-6',
            comment.depth >= INDENT_CAP_DEPTH && 'max-sm:ml-0 max-sm:border-l-0 max-sm:pl-0',
          )}
        >
          {children.map((child) => (
            <CommentItem key={child.commentId} comment={child} shared={shared} />
          ))}
        </div>
      ) : null}

      {problem ? <ReadProblem problem={problem} retry={() => void replies.refetch()} busy={replies.isFetching} /> : null}
      {hasMore && !problem ? (
        <Button type="button" variant="outline" size="sm" className="max-sm:min-h-11" disabled={replies.isFetching} onClick={showMore}>
          {`Show ${remaining} ${children.length > 0 ? 'more ' : ''}${remaining === 1 ? 'reply' : 'replies'}`}
        </Button>
      ) : null}
    </article>
  );
}

/**
 * The comments of an opened post (W02 AS-49, FR-086): a "Sort comments" control (Best, New, Old), up to 25 top-level
 * comments per page with at most five replies embedded in each, **Show {n} more replies** by the reply cursor, a form to
 * write a comment, and a Reply control on every comment up to depth 7. Comments and replies are de-duplicated by
 * `commentId`; a created comment is put into the cached thread, takes focus, and raises the post's comment count.
 */
export function CommentThread({ post, announce }: { post: Pick<PostView, 'postId'> & Partial<PostView>; announce: (text: string) => void }) {
  const client = useQueryClient();
  const [sort, setSort] = useState<ThreadSort>('best');
  const articles = useRef(new Map<string, HTMLElement>());
  // The comment that should take focus as soon as its article exists (a new comment is only there after the next render).
  const wanted = useRef<string | null>(null);

  const thread = useInfiniteQuery({
    queryKey: queryKeys.discussions.thread(post.postId, sort),
    queryFn: ({ pageParam, signal }) => listComments(post.postId, { sort, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const nodes = useMemo(() => unique<CommentNode>(thread.data?.pages.flatMap((page) => page.items) ?? []), [thread.data]);
  const degraded = thread.data?.pages.some((page) => page.degraded === true) ?? false;
  const problem = thread.isError ? problemFromError(thread.error) : undefined;

  const register = useCallback(
    (commentId: string) => (node: HTMLElement | null) => {
      if (!node) {
        articles.current.delete(commentId);
        return;
      }
      articles.current.set(commentId, node);
      if (wanted.current === commentId) {
        wanted.current = null;
        node.focus();
      }
    },
    [],
  );
  const focusComment = useCallback((commentId: string) => {
    const target = articles.current.get(commentId);
    if (target) target.focus();
    else wanted.current = commentId;
  }, []);
  const shared: Shared = { postId: post.postId, announce, register, focusComment };

  // **Show more comments** moves focus to the first comment it added.
  const pendingFocus = useRef<number | null>(null);
  const loadMore = () => {
    pendingFocus.current = nodes.length;
    void thread.fetchNextPage();
  };
  useEffect(() => {
    if (pendingFocus.current === null || nodes.length <= pendingFocus.current) return;
    const added = nodes[pendingFocus.current];
    pendingFocus.current = null;
    if (added) focusComment(added.commentId);
  }, [nodes, focusComment]);

  return (
    <div className="mt-4 space-y-4 border-t pt-4" aria-busy={thread.isFetching}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Comments</h4>
        <div role="group" aria-label="Sort comments" className="flex gap-1">
          {SORTS.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={sort === option.value ? 'secondary' : 'outline'}
              className="max-sm:min-h-11"
              aria-pressed={sort === option.value}
              onClick={() => setSort(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <CommentForm
        postId={post.postId}
        announce={announce}
        onCreated={(comment) => {
          insertTopLevelComment(client, comment, sort);
          bumpCommentCount(client, post.postId);
          focusComment(comment.commentId);
        }}
      />

      {degraded ? (
        <p role="status" className="rounded-lg border px-3 py-2 text-sm">
          {DEGRADED}
        </p>
      ) : null}

      {thread.isPending && !problem ? (
        <div className="space-y-3" aria-hidden="true">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}

      {problem && nodes.length === 0 ? <ReadProblem problem={problem} retry={() => void thread.refetch()} busy={thread.isFetching} /> : null}

      {!thread.isPending && !problem && nodes.length === 0 ? <p className="text-sm text-muted-foreground">No comments yet.</p> : null}

      {nodes.length > 0 ? (
        <div className="space-y-4">
          {nodes.map((node) => (
            <CommentItem key={node.commentId} comment={node} embedded={node.replies} hasMoreEmbedded={node.hasMoreReplies} shared={shared} />
          ))}
        </div>
      ) : null}

      {problem && nodes.length > 0 ? <ReadProblem problem={problem} retry={() => void thread.fetchNextPage()} busy={thread.isFetching} /> : null}
      {thread.hasNextPage && !problem ? (
        <Button type="button" variant="outline" className="min-h-9 max-sm:min-h-11" disabled={thread.isFetchingNextPage} onClick={loadMore}>
          Show more comments
        </Button>
      ) : null}
    </div>
  );
}
