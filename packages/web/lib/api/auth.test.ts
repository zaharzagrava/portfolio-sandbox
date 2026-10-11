import { afterEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../vitest.setup';
import { confirmPasswordReset, register, requestPasswordReset } from './auth';
import { problemFromError } from './errors';

const origin = 'http://localhost:3000';

describe('auth api', () => {
  afterEach(() => vi.restoreAllMocks());

  it('W01 AS-01: register sends only email and password, anonymously (no CSRF header)', async () => {
    let seen: { body: unknown; csrf: string | null } | undefined;
    server.use(
      http.post(`${origin}/api/auth/register`, async ({ request }) => {
        seen = { body: await request.json(), csrf: request.headers.get('x-csrf-token') };
        return HttpResponse.json({ status: 'accepted' }, { status: 202 });
      }),
    );
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
    await register({ email: 'a@b.co', password: 'a-long-password-1' });
    expect(seen).toEqual({ body: { email: 'a@b.co', password: 'a-long-password-1' }, csrf: null });
  });

  it('W01 AS-04: a refusal keeps its stable code and field errors for the screen', async () => {
    server.use(
      http.post(`${origin}/api/auth/register`, () =>
        HttpResponse.json({ code: 'validation_failed', errors: [{ field: 'email', code: 'invalid' }] }, { status: 400 }),
      ),
    );
    const problem = await register({ email: 'x', password: 'y' }).catch(problemFromError);
    expect(problem).toMatchObject({ status: 400, code: 'validation_failed', errors: [{ field: 'email', code: 'invalid' }] });
  });

  it('W01 AS-39: password reset request and confirm go to the S01 routes without CSRF', async () => {
    const paths: string[] = [];
    server.use(
      http.post(`${origin}/api/auth/password-reset/request`, ({ request }) => {
        paths.push(new URL(request.url).pathname);
        return HttpResponse.json({ status: 'accepted' }, { status: 202 });
      }),
      http.post(`${origin}/api/auth/password-reset/confirm`, async ({ request }) => {
        paths.push(`${new URL(request.url).pathname} ${JSON.stringify(await request.json())}`);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await requestPasswordReset('a@b.co');
    await confirmPasswordReset({ token: 't', password: 'new-password-123' });
    expect(paths).toEqual([
      '/api/auth/password-reset/request',
      '/api/auth/password-reset/confirm {"token":"t","password":"new-password-123"}',
    ]);
  });

  it('W01 U-api: a success body that breaks the contract is a status 500 problem', async () => {
    server.use(http.post(`${origin}/api/auth/password-reset/request`, () => HttpResponse.json({ nope: 1 }, { status: 202 })));
    const problem = await requestPasswordReset('a@b.co').catch(problemFromError);
    expect(problem).toMatchObject({ status: 500, code: 'invalid_response' });
  });
});
