'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CommentView, PostView } from '@marketplace-sandbox/contracts';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { putVote } from '@/lib/api/discussions';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';
import { cn } from '@/lib/utils';
import { removeComment, removePost, updateTarget } from './discussions-cache';
import { useDiscussionsView } from './use-discussions-view';

type Value = -1 | 0 | 1;
type Votes = { ups: number; downs: number; score: number; myVote: Value | null };
export type VoteTarget = {
  id: string;
  kind: 'post' | 'comment';
  /** `null` for a tombstone. */
  authorId: string | null;
  /** What the button names say: the post's title, or "comment". */
  name: string;
};

const VANISHED = new Set(['post_not_found', 'comment_not_found', 'target_not_found']);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MAX_WAIT_S = 5;

/** The counts after the shopper's own change to `to`, before the server has answered. */
function optimistic(votes: Votes, to: Value): Votes {
  const from = votes.myVote ?? 0;
  const ups = votes.ups - (from === 1 ? 1 : 0) + (to === 1 ? 1 : 0);
  const downs = votes.downs - (from === -1 ? 1 : 0) + (to === -1 ? 1 : 0);
  return { ups, downs, score: votes.score + (to - from), myVote: to };
}

/**
 * Upvote and Downvote of a post or comment (W02 AS-48, FR-085). A press changes the cached item at once, sends `{value}`
 * (1, -1, or 0 when the pressed button is pressed again) and then shows the server's counts; on any failure the counts
 * from before the press return and the cause is shown beside the buttons. At most one request per target is in flight:
 * a press made meanwhile is sent afterwards as the final value. `409 vote_in_progress` is retried once after its
 * `Retry-After`. The shopper's own content cannot be voted on, and a visitor who is not signed in is asked to sign in.
 */
export function VoteButtons({
  target,
  votes,
  announce,
  inline = false,
  className,
}: {
  target: VoteTarget;
  votes: Votes;
  announce?: (text: string) => void;
  /** A row at every width; by default the buttons are a column from 1024 px (a post's left column). */
  inline?: boolean;
  className?: string;
}) {
  const client = useQueryClient();
  const { user, status } = useAuth();
  const { signInHref } = useDiscussionsView();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [prompt, setPrompt] = useState(false);
  const [explain, setExplain] = useState(false);

  // `confirmed` is what the server last said (where a failure puts the counts back); `current` includes presses it has not
  // answered yet. While nothing is in flight both simply follow the cache.
  const confirmed = useRef<Votes>(votes);
  const current = useRef<Votes>(votes);
  const busy = useRef(false);
  const queued = useRef<Value | undefined>(undefined);
  const { ups, downs, score, myVote } = votes;
  useEffect(() => {
    if (busy.current) return;
    confirmed.current = { ups, downs, score, myVote };
    current.current = { ups, downs, score, myVote };
  }, [ups, downs, score, myVote]);

  const own = user !== null && target.authorId !== null && target.authorId.toLowerCase() === user.id.toLowerCase();
  const ownText = `You can't vote on your own ${target.kind}.`;
  const noteId = `${target.id}-vote-note`;

  const write = (next: Votes) => updateTarget<PostView | CommentView>(client, target.id, (item) => ({ ...item, ...next }));

  async function send(value: Value): Promise<void> {
    busy.current = true;
    try {
      let result;
      try {
        result = await putVote(target.id, value);
      } catch (error) {
        const failure = problemFromError(error);
        if (failure.status !== 409 || failure.code !== 'vote_in_progress') throw error;
        await sleep(Math.min(failure.retryAfterSeconds ?? 1, MAX_WAIT_S) * 1000);
        result = await putVote(target.id, value);
      }
      confirmed.current = { ups: result.ups, downs: result.downs, score: result.score, myVote: result.myVote };
      current.current = confirmed.current;
      write(confirmed.current);
      setProblem(null);
    } catch (error) {
      const failure = problemFromError(error);
      queued.current = undefined;
      if (failure.status === 404 && failure.code !== undefined && VANISHED.has(failure.code)) {
        if (target.kind === 'post') removePost(client, target.id);
        else removeComment(client, target.id);
        announce?.(problemCopy('vote', failure, { target: target.kind }).text);
        busy.current = false;
        return;
      }
      current.current = confirmed.current;
      write(confirmed.current);
      setProblem(failure);
    }
    busy.current = false;
    const pending = queued.current;
    queued.current = undefined;
    if (pending !== undefined && pending !== (confirmed.current.myVote ?? 0)) await send(pending);
  }

  function press(direction: 1 | -1): void {
    if (user === null) {
      setPrompt(true);
      return;
    }
    if (own) {
      setExplain(true);
      return;
    }
    setProblem(null);
    const next: Value = (current.current.myVote ?? 0) === direction ? 0 : direction;
    current.current = optimistic(current.current, next);
    write(current.current);
    if (busy.current) {
      queued.current = next;
      return;
    }
    void send(next);
  }

  const pressed = votes.myVote ?? 0;
  const button = (direction: 1 | -1) => {
    const verb = direction === 1 ? 'Upvote' : 'Downvote';
    const Icon = direction === 1 ? ThumbsUp : ThumbsDown;
    return (
      <Button
        type="button"
        variant={pressed === direction ? 'secondary' : 'ghost'}
        size="icon"
        className={cn('size-8 max-sm:size-11', own && 'opacity-50')}
        aria-label={`${verb} ${target.name}`}
        aria-pressed={pressed === direction}
        aria-disabled={own ? true : undefined}
        aria-describedby={own ? noteId : undefined}
        title={own ? ownText : undefined}
        onClick={() => press(direction)}
      >
        <Icon className="size-4" aria-hidden="true" />
      </Button>
    );
  };

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className={cn('flex items-center gap-1', !inline && 'lg:flex-col')}>
        {button(1)}
        <span className="min-w-6 text-center text-sm font-medium tabular-nums">
          <span className="sr-only">Score </span>
          {votes.score}
        </span>
        {button(-1)}
      </div>
      {own ? (
        <p id={noteId} className={cn('text-xs text-muted-foreground', !explain && 'sr-only')}>
          {ownText}
        </p>
      ) : null}
      {prompt && user === null && status !== 'loading' ? (
        <p role="status" className="text-xs">
          Sign in to vote.{' '}
          <Link href={signInHref} className="underline underline-offset-2">
            Sign in
          </Link>
        </p>
      ) : null}
      {problem ? <ProblemAlert problem={problem} surface="vote" target={target.kind} className="text-xs" /> : null}
    </div>
  );
}
