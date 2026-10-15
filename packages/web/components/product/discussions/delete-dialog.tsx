'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { CommentView } from '@marketplace-sandbox/contracts';
import { ProblemAlert } from '@/components/auth/problem-alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/use-auth';
import { deleteComment, deletePost } from '@/lib/api/discussions';
import { problemFromError, type Problem } from '@/lib/api/errors';
import { problemCopy } from '@/lib/api/problem-copy';
import { removeComment, removePost, updateTarget } from './discussions-cache';

const VANISHED = new Set(['post_not_found', 'comment_not_found', 'target_not_found']);

/**
 * **Delete** with its confirmation dialog (W02 AS-50, FR-087). The button is shown to the author and to `ADMIN` and
 * `MODERATOR` only; that is a convenience, the server decides. `Cancel` has the initial focus and Escape closes the dialog
 * and returns focus to the button. On `204` a post leaves the list and a comment becomes a tombstone; `403` and `409` show
 * the catalogue text beside the button and refresh the lists; a `404` removes the item.
 */
export function DeleteDialog({
  kind,
  id,
  authorId,
  name,
  announce,
  onDeleted,
}: {
  kind: 'post' | 'comment';
  id: string;
  authorId: string | null;
  /** The post's title or "comment": it names the button. */
  name: string;
  announce: (text: string) => void;
  onDeleted?: () => void;
}) {
  const client = useQueryClient();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  const moderator = user?.role === 'ADMIN' || user?.role === 'MODERATOR';
  const author = user !== null && authorId !== null && authorId.toLowerCase() === user.id.toLowerCase();
  if (!user || !(author || moderator)) return null;

  async function confirm(): Promise<void> {
    if (pending) return;
    setPending(true);
    setProblem(null);
    try {
      await (kind === 'post' ? deletePost(id) : deleteComment(id));
      setOpen(false);
      if (kind === 'post') removePost(client, id);
      else {
        updateTarget<CommentView>(client, id, (comment) => ({
          ...comment,
          deleted: true,
          deletedBy: author ? 'author' : 'moderator',
          authorId: null,
          bodyHtml: '',
        }));
      }
      announce(kind === 'post' ? 'Post deleted.' : 'Comment deleted.');
      onDeleted?.();
    } catch (error) {
      const failure = problemFromError(error);
      setOpen(false);
      if (failure.status === 404 && (failure.code === undefined || VANISHED.has(failure.code))) {
        if (kind === 'post') removePost(client, id);
        else removeComment(client, id);
        announce(problemCopy('discussions-write', failure, { target: kind }).text);
      } else {
        setProblem(failure);
        void client.invalidateQueries({ queryKey: ['discussions'] });
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="max-sm:min-h-11" aria-label={`Delete ${name}`}>
            Delete
          </Button>
        </DialogTrigger>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancel.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{`Delete this ${kind}? This can't be undone.`}</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button ref={cancel} type="button" variant="outline" className="max-sm:min-h-11" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" className="max-sm:min-h-11" disabled={pending} onClick={() => void confirm()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {problem ? <ProblemAlert problem={problem} surface="discussions-write" target={kind} className="basis-full" /> : null}
    </>
  );
}
