import { beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../vitest.setup';

const cookieJar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === '__Host-bff-session' && cookieJar.value ? { value: cookieJar.value } : undefined) }),
}));
const redirect = vi.hoisted(() => vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
}));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), cache: <T,>(fn: T) => fn }));
vi.mock('@/lib/config', () => ({ config: { bffUrl: 'http://bff.test' } }));

import { getServerSession, requireServerSession } from './session.server';

describe('session.server', () => {
  beforeEach(() => {
    cookieJar.value = undefined;
    redirect.mockClear();
  });

  it('W01 AS-27: requireServerSession redirects an anonymous visitor to the login page with returnTo', async () => {
    await expect(requireServerSession('/account/security')).rejects.toThrow('NEXT_REDIRECT /login?returnTo=%2Faccount%2Fsecurity');
  });

  it('W01 FR-005: forwards only the session cookie and returns the narrow user, no token', async () => {
    cookieJar.value = 'opaque';
    let seenCookie: string | null = null;
    server.use(
      http.get('http://bff.test/api/bff/session', ({ request }) => {
        seenCookie = request.headers.get('cookie');
        return HttpResponse.json({ user: { id: 'u1', email: 'a@b.co', role: 'SELLER' }, expiresAt: '2026-01-02T00:00:00.000Z' });
      }),
    );
    expect(await getServerSession()).toEqual({ id: 'u1', email: 'a@b.co', role: 'SELLER' });
    expect(seenCookie).toBe('__Host-bff-session=opaque');
    expect(await requireServerSession('/x')).toMatchObject({ id: 'u1' });
  });

  it('W01 AS-65: a 401, a 503 or a malformed answer is treated as no session (guards only redirect)', async () => {
    cookieJar.value = 'opaque';
    server.use(http.get('http://bff.test/api/bff/session', () => HttpResponse.json({ code: 'session_expired' }, { status: 401 })));
    expect(await getServerSession()).toBeNull();
    server.use(http.get('http://bff.test/api/bff/session', () => HttpResponse.json({ user: 1 })));
    expect(await getServerSession()).toBeNull();
  });
});
