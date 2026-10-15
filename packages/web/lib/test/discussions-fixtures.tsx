import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  commentNodeSchema,
  commentViewSchema,
  postViewSchema,
  type CommentNode,
  type CommentView,
  type PostView,
} from '@marketplace-sandbox/contracts';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { SessionUser } from '@/hooks/use-auth';
import { setSessionPresence } from '@/lib/api/session-presence';
import { applyQueryDefaults } from '@/lib/query-defaults';
import { queryKeys } from '@/lib/query-keys';

/**
 * Shared fixtures of the W02 discussions tests. Bodies are parsed with the contract schemas when built, so a fixture
 * that drifts from the wire shape fails loudly.
 */

export const BOARD_ID = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
export const ME = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const origin = 'http://localhost:3000';

const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const postId = (n: number) => uuid('aaaaaaaa', n);
export const commentId = (n: number) => uuid('bbbbbbbb', n);

export function postView(n: number, overrides: Record<string, unknown> = {}): PostView {
  return postViewSchema.parse({
    postId: postId(n),
    boardId: BOARD_ID,
    authorId: OTHER,
    title: `Post ${n}`,
    bodyHtml: `<p>Body of post ${n}</p>`,
    createdAt: '2026-10-14T09:00:00.000Z',
    ups: 0,
    downs: 0,
    score: 0,
    commentCount: 0,
    myVote: 0,
    ...overrides,
  });
}

export function commentView(n: number, overrides: Record<string, unknown> = {}): CommentView {
  return commentViewSchema.parse({
    commentId: commentId(n),
    postId: postId(1),
    parentId: null,
    depth: 0,
    authorId: OTHER,
    bodyHtml: `<p>Comment ${n}</p>`,
    createdAt: '2026-10-14T09:30:00.000Z',
    ups: 0,
    downs: 0,
    score: 0,
    myVote: 0,
    deleted: false,
    replyCount: 0,
    ...overrides,
  });
}

export function commentNode(n: number, overrides: Record<string, unknown> = {}): CommentNode {
  return commentNodeSchema.parse({ ...commentView(n), replies: [], hasMoreReplies: false, ...overrides });
}

export const page = <T,>(items: T[], nextCursor: string | null = null, extra: Record<string, unknown> = {}) => ({
  items,
  nextCursor,
  ...extra,
});

const MEMBER: SessionUser = { id: ME, email: 'me@example.com', role: 'USER' };

/** A session query already holding `user` (or the anonymous `null`), so `useAuth()` answers at once and never fetches. */
export function newClient(user: SessionUser | null = MEMBER): QueryClient {
  const client = applyQueryDefaults(
    new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 }, mutations: { retry: false } } }),
  );
  client.setQueryData(queryKeys.auth.session(), user);
  setSessionPresence(() => user !== null);
  return client;
}

export function renderWith(ui: ReactElement, user: SessionUser | null = MEMBER) {
  const client = newClient(user);
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { client, user: userEvent.setup(), ...view };
}

/** `next/navigation` for the tests: the address is `window.location`, and every history change re-renders readers. */
export async function navigationMock() {
  const { useEffect, useReducer } = await import('react');
  return {
    usePathname: () => window.location.pathname,
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
    useSearchParams: () => {
      const [, force] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        window.addEventListener('test-nav', force);
        return () => window.removeEventListener('test-nav', force);
      }, []);
      return new URLSearchParams(window.location.search);
    },
  };
}

const realPush = window.history.pushState.bind(window.history);
const realReplace = window.history.replaceState.bind(window.history);

/** Call in `beforeEach`: starts on the product page and announces history changes to `useSearchParams`. */
export function resetAddress(search = '?tab=discussions') {
  window.history.pushState = (...args) => {
    realPush(...args);
    window.dispatchEvent(new Event('test-nav'));
  };
  window.history.replaceState = (...args) => {
    realReplace(...args);
    window.dispatchEvent(new Event('test-nav'));
  };
  realReplace(null, '', `/products/${BOARD_ID}${search}`);
}
