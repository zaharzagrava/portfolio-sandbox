import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../vitest.setup';
import { apiClient } from './client';
import { rearmSessionEnd, setSessionEndHandler } from '@/lib/auth/session-ended';
import { setSessionPresence } from './session-presence';

const stubCookies = (value: string) => vi.spyOn(document, 'cookie', 'get').mockReturnValue(value);
const origin = 'http://localhost:3000';

describe('api client', () => {
  let seen: Request[];
  const ended = vi.fn();

  beforeEach(() => {
    seen = [];
    ended.mockClear();
    rearmSessionEnd();
    setSessionEndHandler(ended);
    setSessionPresence(() => true);
    server.use(
      http.all(`${origin}/api/echo`, ({ request }) => {
        seen.push(request.clone());
        return HttpResponse.json({ ok: true });
      }),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('W01 AS-30: has an empty baseURL so every module issues /api/... paths', () => {
    expect(apiClient.defaults.baseURL ?? '').toBe('');
    expect(apiClient.defaults.withCredentials).toBe(true);
  });

  it('W01 AS-28: adds X-CSRF-Token to POST, PUT, PATCH and DELETE but not to GET', async () => {
    stubCookies('__Host-bff-csrf=tok');
    for (const method of ['post', 'put', 'patch', 'delete'] as const) await apiClient.request({ url: '/api/echo', method });
    await apiClient.get('/api/echo');
    expect(seen.map((r) => r.headers.get('x-csrf-token'))).toEqual(['tok', 'tok', 'tok', 'tok', null]);
  });

  it('W01 AS-28: anonymous flows carry no CSRF header', async () => {
    stubCookies('__Host-bff-csrf=tok');
    await apiClient.post('/api/echo', {}, { anonymous: true });
    expect(seen[0].headers.get('x-csrf-token')).toBeNull();
  });

  it('W01 AS-28: a missing CSRF cookie while signed in aborts the request and ends the session', async () => {
    stubCookies('');
    await expect(apiClient.post('/api/echo', {})).rejects.toBeTruthy();
    expect(seen).toHaveLength(0);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('W01 AS-29: never sets an Authorization header', async () => {
    stubCookies('__Host-bff-csrf=tok');
    await apiClient.post('/api/echo', {});
    await apiClient.get('/api/echo');
    expect(seen.every((r) => r.headers.get('authorization') === null)).toBe(true);
  });

  it.each(['session_expired', 'unauthenticated', 'invalid_token'])(
    'W01 AS-26: a 401 %s while signed in ends the session once for concurrent failures',
    async (code) => {
      server.use(http.get(`${origin}/api/private`, () => HttpResponse.json({ code }, { status: 401 })));
      await Promise.allSettled([apiClient.get('/api/private'), apiClient.get('/api/private'), apiClient.get('/api/private')]);
      expect(ended).toHaveBeenCalledTimes(1);
    },
  );

  it('W01 AS-65: 401 with another code, 403 and 404 do not end the session', async () => {
    server.use(
      http.get(`${origin}/api/a`, () => HttpResponse.json({ code: 'invalid_credentials' }, { status: 401 })),
      http.get(`${origin}/api/b`, () => HttpResponse.json({ code: 'forbidden' }, { status: 403 })),
      http.get(`${origin}/api/c`, () => HttpResponse.json({ code: 'not_found' }, { status: 404 })),
    );
    await Promise.allSettled([apiClient.get('/api/a'), apiClient.get('/api/b'), apiClient.get('/api/c')]);
    expect(ended).not.toHaveBeenCalled();
  });

  it('W01 AS-26: a 401 for a visitor who is not signed in does not end anything', async () => {
    setSessionPresence(() => false);
    server.use(http.get(`${origin}/api/private`, () => HttpResponse.json({ code: 'unauthenticated' }, { status: 401 })));
    await apiClient.get('/api/private').catch(() => undefined);
    expect(ended).not.toHaveBeenCalled();
  });
});
