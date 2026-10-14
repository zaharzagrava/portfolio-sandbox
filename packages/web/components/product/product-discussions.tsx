'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { apiClient } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/errors';
import { newIdempotencyKey } from '@/lib/api/idempotency';

export interface PostView {
  postId: string;
  title: string;
  bodyHtml: string;
  createdAt: string;
  ups: number;
  downs: number;
  score: number;
  commentCount: number;
}

/** Each product has its own discussion board (SD-11), addressed by the product id. */
export const productBoardId = (productId: string) => productId;

export function ProductDiscussions({ productId }: { productId: string }) {
  const board = productBoardId(productId);
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const posts = useQuery({
    queryKey: ['discussions', board],
    queryFn: async () => (await apiClient.get<{ items: PostView[] }>(`/api/boards/${board}/posts`, { params: { sort: 'new' } })).data.items,
  });

  // One key per unchanged form: a retry or a double press creates one post.
  const attemptKey = useRef<string | null>(null);
  const create = useMutation({
    mutationFn: () => {
      attemptKey.current ??= newIdempotencyKey();
      return apiClient.post(`/api/boards/${board}/posts`, { title: title.trim(), body: body.trim() }, { headers: { 'Idempotency-Key': attemptKey.current } });
    },
    onSuccess: () => {
      attemptKey.current = null;
      setTitle('');
      setBody('');
      setComposing(false);
      toast.success('Discussion posted');
      void queryClient.invalidateQueries({ queryKey: ['discussions', board] });
    },
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not post.')),
  });

  const vote = useMutation({
    mutationFn: ({ postId, value }: { postId: string; value: 1 | -1 }) => apiClient.put(`/api/votes/${postId}`, { value }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['discussions', board] }),
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not vote.')),
  });

  return (
    <div className="space-y-6" data-testid="discussions">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-medium">Community Discussions</h3>
        {isAuthenticated ? (
          <Button variant="outline" onClick={() => setComposing((c) => !c)}>
            {composing ? 'Cancel' : 'Start a Discussion'}
          </Button>
        ) : (
          <Button variant="outline" asChild>
            <Link href="/login">Log in to discuss</Link>
          </Button>
        )}
      </div>

      {composing && (
        <form
          className="space-y-3 p-4 border rounded-lg"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Input value={title} onChange={(e) => { attemptKey.current = null; setTitle(e.target.value); }} placeholder="Title" aria-label="Discussion title" minLength={3} maxLength={300} required />
          <Textarea value={body} onChange={(e) => { attemptKey.current = null; setBody(e.target.value); }} placeholder="What would you like to discuss?" aria-label="Discussion body" rows={4} />
          <Button type="submit" disabled={create.isPending || title.trim().length < 3}>
            {create.isPending ? 'Posting…' : 'Post'}
          </Button>
        </form>
      )}

      {posts.isLoading && <p className="text-sm text-muted-foreground">Loading discussions…</p>}
      {posts.data?.length === 0 && <p className="text-sm text-muted-foreground">No discussions yet. Be the first to ask.</p>}
      <div className="space-y-4">
        {posts.data?.map((post) => (
          <div key={post.postId} className="p-4 border rounded-lg" data-testid="discussion-post">
            <div className="flex gap-4">
              <div className="flex flex-col items-center gap-1">
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Upvote" disabled={!isAuthenticated} onClick={() => vote.mutate({ postId: post.postId, value: 1 })}>
                  <ThumbsUp className="w-4 h-4" />
                </Button>
                <span className="text-sm font-medium" data-testid="post-score">{post.score}</span>
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Downvote" disabled={!isAuthenticated} onClick={() => vote.mutate({ postId: post.postId, value: -1 })}>
                  <ThumbsDown className="w-4 h-4" />
                </Button>
              </div>
              <div className="min-w-0">
                <div className="font-medium mb-1">{post.title}</div>
                {/* bodyHtml is rendered from markdown and sanitized on the server (allow-list, SD-11). */}
                <div className="text-sm prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: post.bodyHtml }} />
                <div className="text-xs text-muted-foreground mt-2">
                  {new Date(post.createdAt).toLocaleDateString()} · {post.commentCount} comments
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
