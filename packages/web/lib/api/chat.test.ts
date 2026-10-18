import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../vitest.setup';
import * as chatModule from './chat';
import { chatApi, chatProblem } from './chat';
import { ApiParseError } from './parse';

const origin = 'http://localhost:3000';
const CHANNEL = '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const PRODUCT = '7c1d9a2e-0b3f-4c5d-8e6f-2a3b4c5d6e7f';
const SHOP = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const USER = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';
const MESSAGE_ID = 'c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f';
const CLIENT_ID = 'd3e4f5a6-b7c8-4d9e-8f0a-2b3c4d5e6f70';

const channel = (over: Record<string, unknown> = {}) => ({
  id: CHANNEL,
  productId: PRODUCT,
  shopId: SHOP,
  sellerId: USER,
  title: 'Desk lamp',
  isArchived: false,
  archivedAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  myRole: 'MEMBER',
  ...over,
});
const message = (over: Record<string, unknown> = {}) => ({
  id: MESSAGE_ID,
  seq: 4,
  authorId: USER,
  body: 'Hello',
  replyToId: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  deleted: false,
  ...over,
});
const problemBody = (status: number, code: string, extra: Record<string, unknown> = {}) => ({ type: 'about:blank', title: 'Server title', status, detail: 'Server detail', code, ...extra });

let seen: Request[];
let bodies: unknown[];
const record = async (request: Request) => {
  seen.push(request.clone());
  bodies.push(await request.clone().json().catch(() => undefined));
};

beforeEach(() => {
  seen = [];
  bodies = [];
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
});
afterEach(() => vi.restoreAllMocks());

describe('Chat API client', () => {
  it('W05 AS-67 UA9: every call is a same-origin relative /api URL and none carries an Authorization header', async () => {
    server.use(
      http.get(`${origin}/api/chat/channels/mine`, ({ request }) => (void record(request), HttpResponse.json({ items: [], nextCursor: null }))),
      http.get(`${origin}/api/chat/channels/${CHANNEL}`, ({ request }) => (void record(request), HttpResponse.json(channel()))),
      http.post(`${origin}/api/chat/channels/${CHANNEL}/read`, ({ request }) => (void record(request), HttpResponse.json({ lastReadSeq: 4, unread: 0 }))),
    );
    await chatApi.inbox({});
    await chatApi.channel(CHANNEL);
    await chatApi.markRead(CHANNEL, 4);
    expect(seen.map((r) => new URL(r.url).origin)).toEqual([origin, origin, origin]);
    for (const request of seen) expect(request.headers.get('authorization')).toBeNull();
    // CSRF proof only on the write (W01 AS-28)
    expect(seen.map((r) => r.headers.get('x-csrf-token'))).toEqual([null, null, 'tok']);
  });

  it('W05 AS-70 UA9: the inbox is one parsed page {items, nextCursor} with limit and cursor on the query', async () => {
    server.use(
      http.get(`${origin}/api/chat/channels/mine`, ({ request }) => {
        void record(request);
        return HttpResponse.json({ items: [{ ...channel(), unread: 3, lastSeq: 9, lastMessageAt: '2026-10-02T10:00:00.000Z' }], nextCursor: 'next' });
      }),
    );
    const page = await chatApi.inbox({ limit: 20, cursor: 'abc' });
    const url = new URL(seen[0].url);
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('cursor')).toBe('abc');
    expect(page.nextCursor).toBe('next');
    expect(page.items[0]).toMatchObject({ id: CHANNEL, unread: 3, lastSeq: 9 });
  });

  it('W05 AS-70 UA9: a body that breaks the contract schema is an unexpected error, never data', async () => {
    server.use(http.get(`${origin}/api/chat/channels/mine`, () => HttpResponse.json({ items: [{ id: 'not-a-channel' }], nextCursor: null })));
    await expect(chatApi.inbox({})).rejects.toBeInstanceOf(ApiParseError);
    server.use(http.get(`${origin}/api/chat/channels/${CHANNEL}/messages`, () => HttpResponse.json([message()])));
    await expect(chatApi.history(CHANNEL, {})).rejects.toBeInstanceOf(ApiParseError);
  });

  it('W05 AS-12 UA9: history and unread are pages {items, nextCursor}; unknown fields are ignored', async () => {
    server.use(
      http.get(`${origin}/api/chat/channels/${CHANNEL}/messages`, ({ request }) => {
        void record(request);
        return HttpResponse.json({ items: [{ ...message(), extra: 1 }], nextCursor: null });
      }),
      http.get(`${origin}/api/chat/unread`, () => HttpResponse.json({ items: [{ channelId: CHANNEL, unread: 2, lastSeq: 7 }], nextCursor: null })),
    );
    const history = await chatApi.history(CHANNEL, { limit: 50 });
    expect(history).toEqual({ items: [message()], nextCursor: null });
    expect(new URL(seen[0].url).searchParams.get('limit')).toBe('50');
    expect(new URL(seen[0].url).searchParams.has('cursor')).toBe(false);
    expect(await chatApi.unreadPage()).toEqual({ items: [{ channelId: CHANNEL, unread: 2, lastSeq: 7 }], nextCursor: null });
  });

  it('W05 AS-16 UA9: send uses the clientMessageId the caller supplies (no UUID inside), omits an absent reply reference and returns {message, duplicate}', async () => {
    server.use(
      http.post(`${origin}/api/chat/channels/${CHANNEL}/messages`, async ({ request }) => {
        await record(request);
        return seen.length === 1 ? HttpResponse.json({ message: message(), duplicate: false }, { status: 201 }) : HttpResponse.json({ message: message(), duplicate: true }, { status: 200 });
      }),
    );
    const randomUUID = vi.spyOn(crypto, 'randomUUID');
    const first = await chatApi.send({ channelId: CHANNEL, clientMessageId: CLIENT_ID, body: 'Hello' });
    const again = await chatApi.send({ channelId: CHANNEL, clientMessageId: CLIENT_ID, body: 'Hello', replyToId: undefined });
    expect(randomUUID).not.toHaveBeenCalled();
    expect(first).toEqual({ message: message(), duplicate: false });
    expect(again.duplicate).toBe(true);
    expect(bodies).toEqual([
      { clientMessageId: CLIENT_ID, body: 'Hello' },
      { clientMessageId: CLIENT_ID, body: 'Hello' },
    ]);
  });

  it('W05 AS-21 UA9: send carries the reply reference when there is one', async () => {
    server.use(http.post(`${origin}/api/chat/channels/${CHANNEL}/messages`, async ({ request }) => (await record(request), HttpResponse.json({ message: message({ replyToId: MESSAGE_ID }), duplicate: false }, { status: 201 }))));
    const result = await chatApi.send({ channelId: CHANNEL, clientMessageId: CLIENT_ID, body: 'Re', replyToId: MESSAGE_ID });
    expect(bodies[0]).toEqual({ clientMessageId: CLIENT_ID, body: 'Re', replyToId: MESSAGE_ID });
    expect(result.message.replyToId).toBe(MESSAGE_ID);
  });

  it('W05 AS-31 UA9: markRead returns the server response (the badge is set from it)', async () => {
    server.use(http.post(`${origin}/api/chat/channels/${CHANNEL}/read`, async ({ request }) => (await record(request), HttpResponse.json({ lastReadSeq: 8, unread: 1 }))));
    expect(await chatApi.markRead(CHANNEL, 8)).toEqual({ lastReadSeq: 8, unread: 1 });
    expect(bodies[0]).toEqual({ seq: 8 });
  });

  it('W05 AS-20 UA9: deleting a message is a 204 and resolves with nothing', async () => {
    server.use(http.delete(`${origin}/api/chat/channels/${CHANNEL}/messages/${MESSAGE_ID}`, ({ request }) => (void record(request), new HttpResponse(null, { status: 204 }))));
    await expect(chatApi.remove(CHANNEL, MESSAGE_ID)).resolves.toBeUndefined();
    expect(seen[0].method).toBe('DELETE');
    expect(seen[0].headers.get('x-csrf-token')).toBe('tok');
  });

  it('W05 AS-25 UA9: sync posts the cursors and parses every channel result', async () => {
    server.use(
      http.post(`${origin}/api/chat/sync`, async ({ request }) => {
        await record(request);
        return HttpResponse.json([{ channelId: CHANNEL, messages: [message()], lastSeq: 4, hasMore: false }]);
      }),
    );
    const result = await chatApi.sync({ [CHANNEL]: 3 });
    expect(bodies[0]).toEqual({ cursors: { [CHANNEL]: 3 } });
    expect(result).toEqual([{ channelId: CHANNEL, messages: [message()], lastSeq: 4, hasMore: false }]);
  });

  it('W05 AS-33 UA9: receipts, presence and the heartbeat', async () => {
    server.use(
      http.get(`${origin}/api/chat/channels/${CHANNEL}/receipts`, () => HttpResponse.json({ items: [{ userId: USER, lastReadSeq: 5 }], suppressed: false })),
      http.get(`${origin}/api/chat/presence`, ({ request }) => {
        void record(request);
        return HttpResponse.json({ [USER]: { online: true, lastSeenAt: 1700000000 } });
      }),
      http.post(`${origin}/api/chat/presence/heartbeat`, ({ request }) => (void record(request), new HttpResponse(null, { status: 204 }))),
    );
    expect(await chatApi.receipts(CHANNEL)).toEqual({ items: [{ userId: USER, lastReadSeq: 5 }], suppressed: false });
    expect(await chatApi.presence([USER, CHANNEL])).toEqual({ [USER]: { online: true, lastSeenAt: 1700000000 } });
    expect(new URL(seen[0].url).searchParams.get('userIds')).toBe(`${USER},${CHANNEL}`);
    await expect(chatApi.heartbeat()).resolves.toBeUndefined();
  });

  it('W05 AS-01 UA9: lookup by product, create, join and read of one channel are parsed channels', async () => {
    server.use(
      http.get(`${origin}/api/chat/channels/by-product/${PRODUCT}`, () => HttpResponse.json(channel({ myRole: null }))),
      http.post(`${origin}/api/chat/channels`, async ({ request }) => (await record(request), HttpResponse.json(channel({ myRole: 'OWNER' }), { status: 201 }))),
      http.post(`${origin}/api/chat/channels/${CHANNEL}/join`, () => HttpResponse.json(channel())),
    );
    expect((await chatApi.byProduct(PRODUCT)).myRole).toBeNull();
    expect((await chatApi.create(PRODUCT)).myRole).toBe('OWNER');
    expect(bodies[0]).toEqual({ productId: PRODUCT });
    expect((await chatApi.join(CHANNEL)).myRole).toBe('MEMBER');
  });

  it('W05 AS-18 UA9: a problem keeps its code and status, and the extension member mutedUntil is read from the raw body', async () => {
    server.use(
      http.post(`${origin}/api/chat/channels/${CHANNEL}/messages`, () =>
        HttpResponse.json(problemBody(403, 'muted', { mutedUntil: '2026-10-17T12:30:00.000Z', requestId: 'req-1' }), { status: 403, headers: { 'content-type': 'application/problem+json' } }),
      ),
    );
    const error = await chatApi.send({ channelId: CHANNEL, clientMessageId: CLIENT_ID, body: 'x' }).catch((e: unknown) => e);
    expect(chatProblem(error)).toEqual({ status: 403, code: 'muted', errors: [], requestId: 'req-1', mutedUntil: '2026-10-17T12:30:00.000Z' });
  });

  it('W05 AS-19 UA9: Retry-After of a 429 is readable and extension members of the wrong type are ignored', async () => {
    server.use(
      http.post(`${origin}/api/chat/channels/${CHANNEL}/messages`, () =>
        HttpResponse.json(problemBody(429, 'rate_limited', { mutedUntil: 12 }), { status: 429, headers: { 'content-type': 'application/problem+json', 'retry-after': '17' } }),
      ),
    );
    const error = await chatApi.send({ channelId: CHANNEL, clientMessageId: CLIENT_ID, body: 'x' }).catch((e: unknown) => e);
    const problem = chatProblem(error);
    expect(problem).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 17 });
    expect(problem.mutedUntil).toBeUndefined();
  });

  it('W05 AS-05 UA9: a failure that never reached the server has status 0', () => {
    expect(chatProblem(new Error('Network Error'))).toEqual({ status: 0, errors: [] });
  });

  it('W05 AS-25 UA9: the API client no longer owns mergeMessages (it moved to lib/chat/catch-up.ts) or hand-written types', () => {
    expect('mergeMessages' in chatModule).toBe(false);
    expect(Object.keys(chatModule).sort()).toEqual(['chatApi', 'chatProblem']);
  });
});
