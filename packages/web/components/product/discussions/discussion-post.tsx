'use client';

import { useId } from 'react';
import type { PostView } from '@marketplace-sandbox/contracts';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { formatDiscussionTime } from '@/lib/discussions-time';
import { CommentThread } from './comment-thread';
import { DeleteDialog } from './delete-dialog';
import { SafeBody } from './safe-body';
import { VoteButtons } from './vote-buttons';

/**
 * One discussion (W02 AS-45, AS-47, AS-53, FR-082): an `article` named by its title (`h3`), the votes as a column left of
 * the title from 1024 px and as a row under it at 640 px and below, a four-line excerpt of the sanitised body, the author
 * label ("You" or "Community member": no identity is derived from the opaque id), the `<time>`, the comment count, and
 * **Show discussion** which opens the full body and the comments. Everything but the sanitised body is inserted as text.
 */
export function DiscussionPost({
  post,
  expanded,
  onToggle,
  announce,
  titleRef,
  onRemoved,
}: {
  post: PostView;
  expanded: boolean;
  onToggle: () => void;
  announce: (text: string) => void;
  titleRef: (node: HTMLElement | null) => void;
  /** The post was deleted here: where focus goes next is the list's decision. */
  onRemoved: () => void;
}) {
  const { user } = useAuth();
  const titleId = useId();
  const bodyId = useId();
  const mine = user !== null && post.authorId.toLowerCase() === user.id.toLowerCase();
  const time = formatDiscussionTime(post.createdAt);

  return (
    <article aria-labelledby={titleId} className="grid gap-x-4 gap-y-2 rounded-lg border p-4 lg:grid-cols-[3rem_1fr]">
      <h3
        id={titleId}
        ref={titleRef}
        tabIndex={-1}
        className="min-w-0 text-base font-medium break-words outline-none focus-visible:ring-2 focus-visible:ring-ring lg:col-start-2 lg:row-start-1"
      >
        {post.title}
      </h3>
      <VoteButtons
        target={{ id: post.postId, kind: 'post', authorId: post.authorId, name: post.title }}
        votes={{ ups: post.ups, downs: post.downs, score: post.score, myVote: post.myVote }}
        announce={announce}
        className="lg:col-start-1 lg:row-span-3 lg:row-start-1"
      />
      <div id={bodyId} className="min-w-0 space-y-2 lg:col-start-2">
        <SafeBody html={post.bodyHtml} clamp={!expanded} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{mine ? 'You' : 'Community member'}</span>
          <time dateTime={time.dateTime} title={time.title}>
            {time.text}
          </time>
          <span>{post.commentCount === 1 ? '1 comment' : `${post.commentCount} comments`}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-sm:min-h-11"
            aria-expanded={expanded}
            aria-describedby={titleId}
            onClick={onToggle}
          >
            {expanded ? 'Hide discussion' : 'Show discussion'}
          </Button>
          <DeleteDialog kind="post" id={post.postId} authorId={post.authorId} name={post.title} announce={announce} onDeleted={onRemoved} />
        </div>
        {expanded ? <CommentThread post={post} announce={announce} /> : null}
      </div>
    </article>
  );
}
