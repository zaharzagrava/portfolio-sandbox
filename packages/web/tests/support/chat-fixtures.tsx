import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { ReactElement } from 'react';
import type { ChatChannel, ChatInboxItem, ChatInboxPage, ChatMessage } from '@marketplace-sandbox/contracts';
import { setSessionPresence } from '@/lib/api/session-presence';
import { applyQueryDefaults } from '@/lib/query-defaults';
import { queryKeys } from '@/lib/query-keys';
import { server } from '../../vitest.setup';

/**
 * W05 component-test fixtures: contract-shaped builders, a query client with the session seeded (the way `useAuth` reads it),
 * and MSW helpers for the chat routes. Same-origin relative URLs resolve against the jsdom origin.
 */

export const ORIGIN = 'http://localhost:3000';
export const ME = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
export const SELLER = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
export const OTHER = '6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c';
export const PRODUCT = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
export const SHOP = '7c1d9a2e-0b3f-4c5d-8e6f-2a3b4c5d6e7f';
export const CH1 = '11111111-aaaa-4aaa-8aaa-111111111111';
export const CH2 = '22222222-bbbb-4bbb-8bbb-222222222222';
export const CH3 = '33333333-cccc-4ccc-8ccc-333333333333';

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const channel = (over: Partial<ChatChannel> = {}): ChatChannel => ({
  id: CH1,
  productId: PRODUCT,
  shopId: SHOP,
  sellerId: SELLER,
  title: 'Espresso Machine',
  isArchived: false,
  archivedAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  myRole: 'MEMBER',
  ...over,
});

export const inboxItem = (over: Partial<ChatInboxItem> = {}): ChatInboxItem => ({
  ...channel(),
  unread: 0,
  lastSeq: 0,
  lastMessageAt: null,
  ...over,
});

export const inboxPage = (items: ChatInboxItem[], nextCursor: string | null = null): ChatInboxPage => ({ items, nextCursor });

export const message = (seq: number, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: uuid(seq),
  seq,
  authorId: SELLER,
  body: `message ${seq}`,
  replyToId: null,
  createdAt: new Date(Date.UTC(2026, 9, 10, 10, seq)).toISOString(),
  deleted: false,
  ...over,
});

/** A history page, newest first, as the API answers. */
export const historyPage = (messages: ChatMessage[], nextCursor: string | null = null) => ({
  items: [...messages].sort((a, b) => b.seq - a.seq),
  nextCursor,
});

export function problemBody(status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  return HttpResponse.json(
    { type: `https://marketplace.example/problems/${code}`, title: 'Server title the UI must never show', status, detail: 'Server detail the UI must never show', code, requestId: 'req-1', ...extra },
    { status, headers: { 'content-type': 'application/problem+json', ...headers } },
  );
}

export type Role = 'USER' | 'SELLER' | 'MODERATOR' | 'ADMIN';

/** A query client with the signed-in member in the session cache, and the CSRF interceptor told nobody is signed in. */
export function chatClient(user: { id?: string; role?: Role } | null = {}): QueryClient {
  setSessionPresence(() => false);
  const client = applyQueryDefaults(new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }));
  client.setQueryData(queryKeys.auth.session(), user ? { id: user.id ?? ME, email: 'me@example.com', role: user.role ?? 'USER' } : null);
  return client;
}

export function renderChat(ui: ReactElement, options: { client?: QueryClient; user?: { id?: string; role?: Role } | null } = {}) {
  const client = options.client ?? chatClient(options.user);
  const wrap = (node: ReactElement) => <QueryClientProvider client={client}>{node}</QueryClientProvider>;
  const result = render(wrap(ui));
  return { client, ...result, rerenderChat: (next: ReactElement) => result.rerender(wrap(next)) };
}

/** Registers the chat routes a test needs; each returns what the tests count. */
export function mockChatRoutes(routes: {
  inbox?: (cursor: string | null) => Response | ChatInboxPage;
  channel?: (id: string) => Response | ChatChannel;
  history?: (id: string, cursor: string | null) => Response | ReturnType<typeof historyPage>;
}) {
  const calls = { inbox: 0, channel: 0, history: 0 };
  const answer = (value: Response | object) => (value instanceof Response ? value : HttpResponse.json(value));
  server.use(
    // Quiet defaults for the best-effort calls every open conversation makes (receipts, presence, heartbeat); tests override them.
    http.get(`${ORIGIN}/api/chat/channels/:id/receipts`, () => HttpResponse.json({ items: [], suppressed: false })),
    http.get(`${ORIGIN}/api/chat/presence`, () => HttpResponse.json({})),
    http.post(`${ORIGIN}/api/chat/presence/heartbeat`, () => new HttpResponse(null, { status: 204 })),
    ...(routes.inbox
      ? [
          http.get(`${ORIGIN}/api/chat/channels/mine`, ({ request }) => {
            calls.inbox += 1;
            return answer(routes.inbox!(new URL(request.url).searchParams.get('cursor')));
          }),
        ]
      : []),
    ...(routes.history
      ? [
          http.get(`${ORIGIN}/api/chat/channels/:id/messages`, ({ request, params }) => {
            calls.history += 1;
            return answer(routes.history!(String(params.id), new URL(request.url).searchParams.get('cursor')));
          }),
        ]
      : []),
    ...(routes.channel
      ? [
          http.get(`${ORIGIN}/api/chat/channels/:id`, ({ params }) => {
            calls.channel += 1;
            return answer(routes.channel!(String(params.id)));
          }),
        ]
      : []),
  );
  return calls;
}
