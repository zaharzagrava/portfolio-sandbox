import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionApi } from './session';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const stubCookies = (value: string) => vi.spyOn(document, 'cookie', 'get').mockReturnValue(value);
const fetchSpy = (res: Response) =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);

describe('S48 session client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('S48 AS-43: login sends credentials with the cookie jar and returns the user, never a token', async () => {
    const spy = fetchSpy(
      json(200, { user: { id: 'u1', email: 'a@b.co', role: 'USER' }, expiresAt: '2026-01-02T00:00:00.000Z' }),
    );
    const result = await sessionApi.login('a@b.co', 'secret');
    expect(result).toEqual({
      ok: true,
      kind: 'session',
      session: { user: { id: 'u1', email: 'a@b.co', role: 'USER' }, expiresAt: '2026-01-02T00:00:00.000Z' },
    });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/bff/session');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(JSON.parse(String(init?.body))).toEqual({ email: 'a@b.co', password: 'secret' });
  });

  it('S48 AS-48: an mfaRequired answer is reported as such, and the code goes to /mfa', async () => {
    fetchSpy(json(200, { mfaRequired: true }));
    expect(await sessionApi.login('a@b.co', 'x')).toEqual({ ok: true, kind: 'mfa_required' });
    const spy = fetchSpy(json(200, { user: { id: 'u1', email: null, role: 'SELLER' }, expiresAt: 'x' }));
    const result = await sessionApi.verifyMfa('123456');
    expect(result).toMatchObject({ ok: true, kind: 'session' });
    expect(spy.mock.calls[0][0]).toBe('/api/bff/session/mfa');
  });

  it('S48 AS-45: failures are returned by problem code and Retry-After, never by message text', async () => {
    fetchSpy(json(401, { code: 'invalid_credentials', detail: 'The credentials were not accepted.' }));
    expect(await sessionApi.login('a@b.co', 'x')).toEqual({ ok: false, status: 401, code: 'invalid_credentials' });
    fetchSpy(json(429, { code: 'rate_limited' }, { 'Retry-After': '7' }));
    expect(await sessionApi.login('a@b.co', 'x')).toEqual({
      ok: false,
      status: 429,
      code: 'rate_limited',
      retryAfterSeconds: 7,
    });
    fetchSpy(new Response('<html>', { status: 502 }));
    expect(await sessionApi.current()).toEqual({ ok: false, status: 502, code: 'unknown' });
  });

  it('S48 AS-58: logout echoes the readable CSRF cookie in X-CSRF-Token and ends signed out', async () => {
    stubCookies('theme=dark; __Host-bff-csrf=abc%2Bdef.ghi; other=1');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    expect(await sessionApi.logout()).toEqual({ ok: true, kind: 'signed_out' });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/bff/session/logout');
    expect((init?.headers as Record<string, string>)['X-CSRF-Token']).toBe('abc+def.ghi');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
  });

  it('S48 AS-59: a rejected CSRF check is reported by code', async () => {
    stubCookies('');
    fetchSpy(json(403, { code: 'csrf_invalid' }));
    expect(await sessionApi.logout()).toEqual({ ok: false, status: 403, code: 'csrf_invalid' });
  });

  it('S48 AS-51: current() reports an unauthenticated visitor by code', async () => {
    fetchSpy(json(401, { code: 'unauthenticated' }));
    expect(await sessionApi.current()).toEqual({ ok: false, status: 401, code: 'unauthenticated' });
    const spy = fetchSpy(json(200, { user: { id: 'u1', email: 'a@b.co', role: 'ADMIN' }, expiresAt: 'x' }));
    await sessionApi.current();
    expect(spy.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'include' });
  });
});
