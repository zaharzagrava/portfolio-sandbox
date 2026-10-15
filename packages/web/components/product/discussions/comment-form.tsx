'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import type { CommentView } from '@marketplace-sandbox/contracts';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { createComment } from '@/lib/api/discussions';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';
import { removeComment, removePost } from './discussions-cache';
import { useDiscussionsView } from './use-discussions-view';
import { useWriteAttempt } from './use-write-attempt';

const MAX = 10_000;
const COUNTER_FROM = MAX - 200;
const FIELD_ERROR = 'Comments must be 1 to 10,000 characters.';
const codePoints = (text: string) => [...text].length;

/**
 * "Write a comment" under a post, or "Write a reply" under a comment (W02 AS-49, FR-086): 1 to 10,000 characters, one
 * `Idempotency-Key` per attempt kept for retries of the unchanged text, errors beside the form with the text kept. A
 * visitor who is not signed in gets "Log in to discuss" instead (AS-51).
 */
export function CommentForm({
  postId,
  parent,
  onCreated,
  onCancel,
  announce,
  autoFocus = false,
}: {
  postId: string;
  /** The comment being answered; absent for a top-level comment. */
  parent?: CommentView;
  onCreated: (comment: CommentView) => void;
  onCancel?: () => void;
  announce: (text: string) => void;
  autoFocus?: boolean;
}) {
  const client = useQueryClient();
  const { user, status } = useAuth();
  const { signInHref } = useDiscussionsView();
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const attempt = useWriteAttempt();
  const field = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const reply = parent !== undefined;

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  if (!user) {
    return status === 'loading' ? null : (
      <p className="text-sm">
        <Link href={signInHref} className="underline underline-offset-2">
          Log in to discuss
        </Link>
      </p>
    );
  }

  const size = codePoints(text.trim());
  const tooLong = size > MAX;
  const fieldError = problem?.status === 400 && problem.errors.length > 0 ? FIELD_ERROR : undefined;

  async function submit(): Promise<void> {
    const key = attempt.begin();
    if (key === null || size === 0 || tooLong) {
      if (key !== null) attempt.end();
      return;
    }
    setPending(true);
    setProblem(null);
    try {
      const comment = await createComment(postId, parent ? { body: text.trim(), parentId: parent.commentId } : { body: text.trim() }, key);
      attempt.renew();
      setText('');
      onCreated(comment);
    } catch (error) {
      const failure = problemFromError(error);
      if (failure.status === 404 && (failure.code === 'parent_not_found' || failure.code === 'comment_not_found') && parent) {
        removeComment(client, parent.commentId);
        announce(problemCopy('discussions-write', failure, { target: 'comment' }).text);
        onCancel?.();
      } else if (failure.status === 404 && failure.code === 'post_not_found') {
        removePost(client, postId);
        announce(problemCopy('discussions-write', failure, { target: 'post' }).text);
      } else {
        setProblem(failure);
      }
    } finally {
      attempt.end();
      setPending(false);
    }
  }

  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={`${id}-text`} className="block text-sm font-medium">
        {reply ? 'Write a reply' : 'Write a comment'}
      </label>
      <Textarea
        id={`${id}-text`}
        ref={field}
        value={text}
        rows={3}
        className="max-sm:min-h-24"
        aria-invalid={fieldError ? true : undefined}
        aria-describedby={fieldError ? `${id}-error` : undefined}
        onChange={(event) => {
          attempt.renew();
          setText(event.target.value);
        }}
      />
      {size >= COUNTER_FROM ? (
        <p className={tooLong ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{`${size} / ${MAX}`}</p>
      ) : null}
      {fieldError ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {fieldError}
        </p>
      ) : null}
      {problem && !fieldError ? <ProblemAlert problem={problem} surface="discussions-write" target="comment" /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-9 max-sm:min-h-11" disabled={pending || size === 0 || tooLong}>
          {reply ? 'Post reply' : 'Post comment'}
        </Button>
        {onCancel ? (
          <Button type="button" variant="outline" className="min-h-9 max-sm:min-h-11" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
