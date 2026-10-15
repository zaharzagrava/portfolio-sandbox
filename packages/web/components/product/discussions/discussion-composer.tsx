'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { PostView } from '@marketplace-sandbox/contracts';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createPost } from '@/lib/api/discussions';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { useWriteAttempt } from './use-write-attempt';

const TITLE_MIN = 3;
const TITLE_MAX = 300;
const BODY_MAX = 40_000;
/** A counter shows within this many characters of a limit. */
const COUNTER_WINDOW = 200;

const FIELD_MESSAGES: Record<string, string> = {
  title: 'Title must be 3 to 300 characters.',
  body: 'Details can be at most 40,000 characters.',
};
const codePoints = (text: string) => [...text].length;

/**
 * **Start a discussion** (W02 AS-46, AS-74, FR-083): a form inside the panel with "Title" (3 to 300 characters, trimmed)
 * and "Details (optional)" (up to 40,000, by code point). Post is disabled while a request runs and until the title has
 * three characters; the attempt's `Idempotency-Key` is kept for retries of the unchanged form and replaced after a success
 * or an edit; a double press posts once. Field errors show under their field, other problems beside Post, and the text is
 * never cleared by a failure. Nothing typed is written to the console.
 */
export function DiscussionComposer({
  productId,
  onPosted,
  onCancel,
}: {
  productId: string;
  onPosted: (post: PostView) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const attempt = useWriteAttempt();
  const titleField = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    titleField.current?.focus();
  }, []);

  const titleSize = codePoints(title.trim());
  const bodySize = codePoints(body);
  const invalid = titleSize < TITLE_MIN || titleSize > TITLE_MAX || bodySize > BODY_MAX;

  const fieldErrors = new Map<string, string>();
  if (problem?.status === 400) {
    for (const error of problem.errors) {
      const message = FIELD_MESSAGES[error.field];
      if (message) fieldErrors.set(error.field, message);
    }
  }
  const generic = problem && fieldErrors.size === 0 ? problem : undefined;

  async function submit(): Promise<void> {
    if (invalid) return;
    const key = attempt.begin();
    if (key === null) return;
    setPending(true);
    setProblem(null);
    try {
      const trimmedBody = body.trim();
      const post = await createPost(productId, trimmedBody ? { title: title.trim(), body: trimmedBody } : { title: title.trim() }, key);
      attempt.renew();
      onPosted(post);
    } catch (error) {
      setProblem(problemFromError(error));
    } finally {
      attempt.end();
      setPending(false);
    }
  }

  const describedBy = (field: 'title' | 'body') => [fieldErrors.has(field) ? `${id}-${field}-error` : null, field === 'body' ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;

  return (
    <form
      aria-label="Start a discussion"
      className="space-y-3 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-1">
        <label htmlFor={`${id}-title`} className="block text-sm font-medium">
          Title
        </label>
        <Input
          id={`${id}-title`}
          ref={titleField}
          value={title}
          className="max-sm:h-11"
          aria-invalid={fieldErrors.has('title') ? true : undefined}
          aria-describedby={describedBy('title')}
          onChange={(event) => {
            attempt.renew();
            setTitle(event.target.value);
          }}
        />
        {titleSize >= TITLE_MAX - COUNTER_WINDOW ? (
          <p className={titleSize > TITLE_MAX ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{`${titleSize} / ${TITLE_MAX}`}</p>
        ) : null}
        {fieldErrors.has('title') ? (
          <p id={`${id}-title-error`} className="text-sm text-destructive">
            {fieldErrors.get('title')}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label htmlFor={`${id}-body`} className="block text-sm font-medium">
          Details (optional)
        </label>
        <Textarea
          id={`${id}-body`}
          value={body}
          rows={4}
          aria-invalid={fieldErrors.has('body') ? true : undefined}
          aria-describedby={describedBy('body')}
          onChange={(event) => {
            attempt.renew();
            setBody(event.target.value);
          }}
        />
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          Markdown supported: bold, italic, links, lists, quotes and code.
        </p>
        {bodySize >= BODY_MAX - COUNTER_WINDOW ? (
          <p className={bodySize > BODY_MAX ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{`${bodySize} / ${BODY_MAX}`}</p>
        ) : null}
        {fieldErrors.has('body') ? (
          <p id={`${id}-body-error`} className="text-sm text-destructive">
            {fieldErrors.get('body')}
          </p>
        ) : null}
      </div>

      {generic ? <ProblemAlert problem={generic} surface="discussions-write" target="post" /> : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-9 max-sm:min-h-11" disabled={pending || invalid}>
          Post
        </Button>
        <Button type="button" variant="outline" className="min-h-9 max-sm:min-h-11" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
