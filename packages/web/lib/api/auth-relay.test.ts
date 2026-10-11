// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jar = new Map<string, string>();
const cookieStore = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  set: vi.fn((name: string, value: string) => void jar.set(name, value)),
  delete: vi.fn((name: string) => void jar.delete(name)),
};
vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));

import { REFRESH_COOKIE, relay } from './auth-relay';

const upstream = vi.fn();
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { host: 'localhost:3000', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const session = { accessToken: { token: 'access', expiresIn: 300 }, refreshToken: 'refresh-1', user: { id: 'u' } };

beforeEach(() => {
  jar.clear();
  cookieStore.set.mockClear();
  cookieStore.delete.mockClear();
  upstream.mockReset();
  vi.stubGlobal('fetch', upstream);
});

describe('credential relay', () => {
  it('keeps the refresh token in an HttpOnly cookie and out of the body', async () => {
    upstream.mockResolvedValue(Response.json(session));
    const response = await relay(post('/api/auth/login', { email: 'a@b.c', password: 'x' }), '/api/auth/login');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accessToken: session.accessToken, user: session.user });
    expect(cookieStore.set).toHaveBeenCalledWith(
      REFRESH_COOKIE,
      'refresh-1',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('refreshes from the cookie, rotating it', async () => {
    jar.set(REFRESH_COOKIE, 'refresh-1');
    upstream.mockResolvedValue(Response.json({ ...session, refreshToken: 'refresh-2' }));
    const response = await relay(post('/api/auth/refresh', {}), '/api/auth/refresh', { fromCookie: true });

    expect(JSON.parse(upstream.mock.calls[0][1].body)).toEqual({ refreshToken: 'refresh-1' });
    expect(jar.get(REFRESH_COOKIE)).toBe('refresh-2');
    expect(await response.json()).not.toHaveProperty('refreshToken');
  });

  it('answers a visitor without a cookie itself, spending nothing upstream', async () => {
    const response = await relay(post('/api/auth/refresh', {}), '/api/auth/refresh', { fromCookie: true });
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('drops the cookie when the refresh is refused', async () => {
    jar.set(REFRESH_COOKIE, 'stale');
    upstream.mockResolvedValue(Response.json({ code: 'invalid_token' }, { status: 401 }));
    const response = await relay(post('/api/auth/refresh', {}), '/api/auth/refresh', { fromCookie: true });
    expect(response.status).toBe(401);
    expect(jar.has(REFRESH_COOKIE)).toBe(false);
  });

  it('refuses a call from another origin', async () => {
    const response = await relay(
      post('/api/auth/refresh', {}, { origin: 'https://evil.example' }),
      '/api/auth/refresh',
      { fromCookie: true },
    );
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('passes a failed login through untouched', async () => {
    upstream.mockResolvedValue(Response.json({ code: 'invalid_credentials' }, { status: 401 }));
    const response = await relay(post('/api/auth/login', {}), '/api/auth/login');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'invalid_credentials' });
    expect(cookieStore.set).not.toHaveBeenCalled();
  });
});
