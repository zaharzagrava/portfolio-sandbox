import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../vitest.setup';

const cookieJar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === '__Host-bff-session' && cookieJar.value ? { value: cookieJar.value } : undefined) }),
}));
vi.mock('@/lib/config', () => ({ config: { bffUrl: 'http://bff.test' } }));

import { getInboxPage } from './chat.server';

const item = {
  id: '11111111-aaaa-4aaa-8aaa-111111111111',
  productId: '3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b',
  shopId: '7c1d9a2e-0b3f-4c5d-8e6f-2a3b4c5d6e7f',
  sellerId: '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b',
  title: 'Lamp',
  isArchived: false,
  archivedAt: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  myRole: 'MEMBER',
  unread: 2,
  lastSeq: 4,
  lastMessageAt: '2026-10-10T10:00:00.000Z',
};

describe('chat.server', () => {
  beforeEach(() => {
    cookieJar.value = 'opaque';
  });

  it('W05 AS-69: reads the first inbox page through the forwarder with only the session cookie, parsed by chatInboxPageSchema', async () => {
    let cookie: string | null = null;
    let auth: string | null = 'unset';
    let query = '';
    server.use(
      http.get('http://bff.test/api/bff/f/chat/channels/mine', ({ request }) => {
        cookie = request.headers.get('cookie');
        auth = request.headers.get('authorization');
        query = new URL(request.url).search;
        return HttpResponse.json({ items: [item], nextCursor: null });
      }),
    );
    const result = await getInboxPage();
    expect(result).toMatchObject({ ok: true, data: { items: [{ id: item.id, unread: 2 }], nextCursor: null } });
    expect(cookie).toBe('__Host-bff-session=opaque');
    expect(auth).toBeNull();
    expect(query).toBe('?limit=50');
  });

  it('W05 AS-69: a failed read is a value, never a throw, and a body that does not match the schema is a 502', async () => {
    server.use(http.get('http://bff.test/api/bff/f/chat/channels/mine', () => HttpResponse.json({ code: 'internal' }, { status: 500 })));
    expect(await getInboxPage()).toMatchObject({ ok: false, status: 500 });
    server.use(http.get('http://bff.test/api/bff/f/chat/channels/mine', () => HttpResponse.json({ nope: true })));
    expect(await getInboxPage()).toMatchObject({ ok: false, status: 502 });
  });

  it('W05 AS-69: no session cookie means 401 without a request', async () => {
    cookieJar.value = undefined;
    expect(await getInboxPage()).toMatchObject({ ok: false, status: 401 });
  });
});
