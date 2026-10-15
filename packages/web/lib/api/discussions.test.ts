import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/vitest.setup';
import { setSessionPresence } from '@/lib/api/session-presence';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { problemResponse } from '@/lib/test/msw-handlers';
import { BOARD_ID, commentId, commentNode, commentView, origin, page, postId, postView } from '@/lib/test/discussions-fixtures';
import { problemFromError } from '@/lib/api/errors';
import {
  createComment,
  createPost,
  deleteComment,
  deletePost,
  listComments,
  listPosts,
  listReplies,
  putVote,
} from '@/lib/api/discussions';

const KEY = '9b2f6c1e-0000-4000-8000-000000000001';
let seen: Request[];
const record = (request: Request) => seen.push(request.clone());

beforeEach(() => {
  seen = [];
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  setSessionPresence(() => true);
  rearmSessionEnd();
});
afterEach(() => {
  vi.restoreAllMocks();
  setSessionEndHandler(null);
  setSessionPresence(() => false);
});

const url = (request: Request) => new URL(request.url);

describe('discussions reads (W02 FR-080, FR-081)', () => {
  it('W02 AS-45: listPosts asks the board of the product for 20 posts and sends window only with top', async () => {
    server.use(
      http.get(`${origin}/api/boards/${BOARD_ID}/posts`, ({ request }) => {
        record(request);
        return HttpResponse.json(page([postView(1)], 'c1'));
      }),
    );
    const result = await listPosts(BOARD_ID, { sort: 'hot' });
    expect(result.items[0]!.postId).toBe(postId(1));
    expect(result.nextCursor).toBe('c1');
    await listPosts(BOARD_ID, { sort: 'top', window: 'week', cursor: 'abc' });
    await listPosts(BOARD_ID, { sort: 'new', window: 'week' });
    expect(Object.fromEntries(url(seen[0]!).searchParams)).toEqual({ sort: 'hot', limit: '20' });
    expect(Object.fromEntries(url(seen[1]!).searchParams)).toEqual({ sort: 'top', window: 'week', limit: '20', cursor: 'abc' });
    expect(Object.fromEntries(url(seen[2]!).searchParams)).toEqual({ sort: 'new', limit: '20' });
    expect(seen[0]!.headers.get('authorization')).toBeNull();
  });

  it('W02 AS-45: a body that does not match the contract fails as invalid_response (500)', async () => {
    server.use(http.get(`${origin}/api/boards/${BOARD_ID}/posts`, () => HttpResponse.json({ posts: [] })));
    const error = await listPosts(BOARD_ID, { sort: 'hot' }).catch((e: unknown) => e);
    expect(problemFromError(error)).toMatchObject({ status: 500, code: 'invalid_response' });
  });

  it('W02 AS-49: listComments asks for 25 top-level comments and listReplies for the given limit and cursor', async () => {
    server.use(
      http.get(`${origin}/api/posts/${postId(1)}/comments`, ({ request }) => {
        record(request);
        return HttpResponse.json(page([commentNode(1, { replies: [commentView(2, { parentId: commentId(1), depth: 1 })] })]));
      }),
      http.get(`${origin}/api/comments/${commentId(1)}/replies`, ({ request }) => {
        record(request);
        return HttpResponse.json(page([commentView(3)], null, { degraded: true }));
      }),
    );
    const thread = await listComments(postId(1), { sort: 'best' });
    expect(thread.items[0]!.replies).toHaveLength(1);
    const replies = await listReplies(commentId(1), { limit: 10, cursor: 'r1' });
    expect(replies.degraded).toBe(true);
    expect(Object.fromEntries(url(seen[0]!).searchParams)).toEqual({ sort: 'best', limit: '25' });
    expect(Object.fromEntries(url(seen[1]!).searchParams)).toEqual({ limit: '10', cursor: 'r1' });
  });
});

describe('discussions writes (W02 FR-080, FR-083, FR-159)', () => {
  it('W02 AS-46: createPost sends the Idempotency-Key and the CSRF header, the title and body only, and no Authorization', async () => {
    let body: unknown;
    server.use(
      http.post(`${origin}/api/boards/${BOARD_ID}/posts`, async ({ request }) => {
        record(request);
        body = await request.json();
        return HttpResponse.json(postView(1), { status: 201 });
      }),
    );
    const created = await createPost(BOARD_ID, { title: 'Does it fit?', body: 'Yes' }, KEY);
    expect(created.postId).toBe(postId(1));
    expect(body).toEqual({ title: 'Does it fit?', body: 'Yes' });
    expect(seen[0]!.headers.get('idempotency-key')).toBe(KEY);
    expect(seen[0]!.headers.get('x-csrf-token')).toBe('tok');
    expect(seen[0]!.headers.get('authorization')).toBeNull();
  });

  it('W02 AS-49: createComment sends parentId only for a reply', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post(`${origin}/api/posts/${postId(1)}/comments`, async ({ request }) => {
        record(request);
        bodies.push(await request.json());
        return HttpResponse.json(commentView(1), { status: 201 });
      }),
    );
    await createComment(postId(1), { body: 'Top' }, KEY);
    await createComment(postId(1), { body: 'Reply', parentId: commentId(1) }, KEY);
    expect(bodies).toEqual([{ body: 'Top' }, { body: 'Reply', parentId: commentId(1) }]);
    expect(seen[1]!.headers.get('idempotency-key')).toBe(KEY);
  });

  it('W02 AS-48: putVote sends {value} only to /api/votes/{targetId} and returns the server counts', async () => {
    let body: unknown;
    server.use(
      http.put(`${origin}/api/votes/${postId(1)}`, async ({ request }) => {
        record(request);
        body = await request.json();
        return HttpResponse.json({ targetId: postId(1), targetType: 'post', ups: 1, downs: 0, score: 1, myVote: 1 });
      }),
    );
    const result = await putVote(postId(1), -1);
    expect(body).toEqual({ value: -1 });
    expect(result).toMatchObject({ score: 1, myVote: 1 });
    expect(seen[0]!.headers.get('x-csrf-token')).toBe('tok');
  });

  it('W02 AS-50: deletePost and deleteComment send DELETE with the CSRF header and resolve on 204', async () => {
    server.use(
      http.delete(`${origin}/api/posts/${postId(1)}`, ({ request }) => {
        record(request);
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete(`${origin}/api/comments/${commentId(1)}`, ({ request }) => {
        record(request);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(deletePost(postId(1))).resolves.toBeUndefined();
    await expect(deleteComment(commentId(1))).resolves.toBeUndefined();
    expect(seen.map((r) => r.method)).toEqual(['DELETE', 'DELETE']);
    expect(seen.every((r) => r.headers.get('x-csrf-token') === 'tok')).toBe(true);
  });

  it('W02 AS-74: a write made while offline fails at once as status 0 and sends nothing', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    server.use(
      http.post(`${origin}/api/boards/${BOARD_ID}/posts`, ({ request }) => {
        record(request);
        return HttpResponse.json(postView(1));
      }),
    );
    const error = await createPost(BOARD_ID, { title: 'Offline title' }, KEY).catch((e: unknown) => e);
    expect(problemFromError(error).status).toBe(0);
    expect(seen).toHaveLength(0);
    // reads are not blocked: the browser decides
  });

  it('W02 AS-51: a 401 answer to a write while signed in runs the session-ended flow once, whatever the code', async () => {
    const ended = vi.fn();
    setSessionEndHandler(ended);
    server.use(
      http.post(`${origin}/api/boards/${BOARD_ID}/posts`, () => problemResponse(401, 'unauthorized')),
      http.put(`${origin}/api/votes/${postId(1)}`, () => problemResponse(401, 'unauthorized')),
    );
    await createPost(BOARD_ID, { title: 'Typed title' }, KEY).catch(() => undefined);
    await putVote(postId(1), 1).catch(() => undefined);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('W02 AS-51: a 401 with nobody signed in does not run the flow', async () => {
    const ended = vi.fn();
    setSessionEndHandler(ended);
    setSessionPresence(() => false);
    server.use(http.put(`${origin}/api/votes/${postId(1)}`, () => problemResponse(401, 'unauthorized')));
    await putVote(postId(1), 1).catch(() => undefined);
    expect(ended).not.toHaveBeenCalled();
  });

  it('W02 AS-48: a failed write rejects with the status, code and Retry-After the copy catalogue reads', async () => {
    server.use(http.put(`${origin}/api/votes/${postId(1)}`, () => problemResponse(409, 'vote_in_progress', { retryAfter: 2 })));
    const error = await putVote(postId(1), 1).catch((e: unknown) => e);
    expect(problemFromError(error)).toMatchObject({ status: 409, code: 'vote_in_progress', retryAfterSeconds: 2 });
  });
});
