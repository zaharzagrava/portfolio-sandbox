import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../vitest.setup';
import * as account from './account';
import { problemFromError } from './errors';
import { setSessionPresence } from './session-presence';

const origin = 'http://localhost:3000';
const codes = Array.from({ length: 10 }, (_, i) => `ABCD${(i % 8) + 2}-EFGH${(i % 8) + 2}`);

describe('account api', () => {
  beforeEach(() => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue('__Host-bff-csrf=tok');
    setSessionPresence(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('W01 AS-45: reads and parses the two-step status and sessions', async () => {
    server.use(
      http.get(`${origin}/api/auth/mfa`, () => HttpResponse.json({ state: 'enabled', enabledAt: '2026-01-01T00:00:00Z', recoveryCodesRemaining: 2 })),
      http.get(`${origin}/api/auth/sessions`, () =>
        HttpResponse.json([{ sessionId: 's1', device: 'Firefox', ip: '10.0.0.1', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null, current: true }]),
      ),
    );
    expect(await account.getMfaStatus()).toMatchObject({ state: 'enabled', recoveryCodesRemaining: 2 });
    expect(await account.listSessions()).toHaveLength(1);
  });

  it('W01 AS-46: enrol, confirm, regenerate and disable carry the CSRF header', async () => {
    const seen: string[] = [];
    const record = ({ request }: { request: Request }) => {
      seen.push(`${request.method} ${new URL(request.url).pathname} ${request.headers.get('x-csrf-token')}`);
    };
    server.use(
      http.post(`${origin}/api/auth/mfa/enroll`, ({ request }) => {
        record({ request });
        return HttpResponse.json({ otpauthUri: 'otpauth://totp/x?secret=A', manualEntryKey: 'A' });
      }),
      http.post(`${origin}/api/auth/mfa/confirm`, ({ request }) => {
        record({ request });
        return HttpResponse.json({ recoveryCodes: codes });
      }),
      http.post(`${origin}/api/auth/mfa/recovery-codes/regenerate`, ({ request }) => {
        record({ request });
        return HttpResponse.json({ recoveryCodes: codes });
      }),
      http.post(`${origin}/api/auth/mfa/disable`, ({ request }) => {
        record({ request });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await account.enrollMfa();
    expect((await account.confirmMfa('123456')).recoveryCodes).toHaveLength(10);
    await account.regenerateRecoveryCodes('123456');
    await account.disableMfa('123456');
    expect(seen).toEqual([
      'POST /api/auth/mfa/enroll tok',
      'POST /api/auth/mfa/confirm tok',
      'POST /api/auth/mfa/recovery-codes/regenerate tok',
      'POST /api/auth/mfa/disable tok',
    ]);
  });

  it('W01 AS-55: revoking a session and unlinking an identity use DELETE with the id encoded', async () => {
    const seen: string[] = [];
    server.use(
      http.delete(`${origin}/api/auth/sessions/:id`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json({ code: 'session_not_found' }, { status: 404 });
      }),
      http.delete(`${origin}/api/auth/identities/:id`, ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const problem = await account.revokeSession('a/b').catch(problemFromError);
    expect(problem).toMatchObject({ status: 404, code: 'session_not_found' });
    await account.unlinkIdentity('id-1');
    expect(seen).toEqual(['/api/auth/sessions/a%2Fb', '/api/auth/identities/id-1']);
  });

  it('W01 U-api: a body that breaks the contract is a status 500 problem', async () => {
    server.use(http.get(`${origin}/api/auth/identities`, () => HttpResponse.json([{ id: 'not-a-uuid' }])));
    expect(await account.listIdentities().catch(problemFromError)).toMatchObject({ status: 500, code: 'invalid_response' });
  });

  it('W01 AS-58: provider list and start return parsed data', async () => {
    server.use(
      http.get(`${origin}/api/auth/oidc/providers`, () => HttpResponse.json([{ id: 'google', displayName: 'Google' }])),
      http.post(`${origin}/api/auth/oidc/google/start`, () => HttpResponse.json({ authorizationUrl: 'https://accounts.example/auth' })),
    );
    expect(await account.listOidcProviders()).toEqual([{ id: 'google', displayName: 'Google' }]);
    expect(await account.startOidc('/')).toEqual({ authorizationUrl: 'https://accounts.example/auth' });
  });
});
