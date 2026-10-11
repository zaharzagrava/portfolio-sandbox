import { mfaRequiredResponseSchema, sessionResponseSchema } from '@marketplace-sandbox/contracts';
import { csrfHeaders } from './csrf';

/**
 * Browser session through the BFF (token handler, S48 contracts/http.md). The browser never reads or stores a token:
 * it holds an HttpOnly `__Host-bff-session` cookie and a readable `__Host-bff-csrf` cookie that is echoed in
 * `X-CSRF-Token` on cookie-authenticated `POST`s. The API and the web app share one origin (`next.config.ts` rewrites
 * `/api/bff/*`), which is what makes the `__Host-` cookies valid.
 *
 * Callers switch on the problem `code`, never on message text. Every success body is parsed with the contracts schemas;
 * a body that does not match is reported as a `500 invalid_response`.
 */
export type SessionRole = 'USER' | 'SELLER' | 'MODERATOR' | 'ADMIN';

export interface SessionView {
  user: { id: string; email: string | null; role: SessionRole };
  /** ISO-8601: when the session ends if it stays idle. */
  expiresAt: string;
}

export type SessionFailure = {
  ok: false;
  status: number;
  /** The BFF's / identity service's problem `code`; `unknown` when the answer carried none. */
  code: string;
  retryAfterSeconds?: number;
  requestId?: string;
};

export type SessionResult =
  | { ok: true; kind: 'session'; session: SessionView }
  | { ok: true; kind: 'mfa_required' }
  | { ok: true; kind: 'signed_out' }
  | SessionFailure;

const BASE = '/api/bff/session';

async function failure(res: Response): Promise<SessionFailure> {
  let code = 'unknown';
  let requestId: string | undefined;
  try {
    const body = (await res.json()) as { code?: unknown; requestId?: unknown };
    if (typeof body.code === 'string') code = body.code;
    if (typeof body.requestId === 'string') requestId = body.requestId;
  } catch {
    /* no problem document: keep `unknown` */
  }
  const retry = Number(res.headers.get('retry-after'));
  return {
    ok: false,
    status: res.status,
    code,
    ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

async function send(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; csrf?: boolean },
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.csrf) Object.assign(headers, csrfHeaders());
  return fetch(`${BASE}${path}`, {
    method: init.method,
    headers,
    credentials: 'include',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const invalidResponse = (): SessionFailure => ({ ok: false, status: 500, code: 'invalid_response' });

async function sessionResult(res: Response): Promise<SessionResult> {
  if (!res.ok) return failure(res);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return invalidResponse();
  }
  const mfa = mfaRequiredResponseSchema.safeParse(body);
  if (mfa.success) return { ok: true, kind: 'mfa_required' };
  const session = sessionResponseSchema.safeParse(body);
  if (!session.success) return invalidResponse();
  return { ok: true, kind: 'session', session: session.data };
}

/** The network can fail before any answer exists: report it as status 0 so callers show the offline copy. */
async function guarded(run: () => Promise<SessionResult>): Promise<SessionResult> {
  try {
    return await run();
  } catch {
    return { ok: false, status: 0, code: 'network_error' };
  }
}

export const sessionApi = {
  /** Password login (anonymous: no CSRF). `mfa_required` means: ask for the second factor and call `verifyMfa`. */
  login(email: string, password: string): Promise<SessionResult> {
    return guarded(async () => sessionResult(await send('', { method: 'POST', body: { email, password } })));
  },

  verifyMfa(code: string): Promise<SessionResult> {
    return guarded(async () => sessionResult(await send('/mfa', { method: 'POST', body: { code } })));
  },

  /** The signed-in user, or a `401` problem (`unauthenticated`, `session_expired`). */
  current(): Promise<SessionResult> {
    return guarded(async () => sessionResult(await send('', { method: 'GET' })));
  },

  /** Idempotent: always ends signed out unless the CSRF check fails. */
  logout(): Promise<SessionResult> {
    return guarded(async () => {
      const res = await send('/logout', { method: 'POST', csrf: true });
      return res.ok ? { ok: true, kind: 'signed_out' } : failure(res);
    });
  },

  /** Forces an identity refresh so a changed role shows (C-REFRESH). */
  refresh(): Promise<SessionResult> {
    return guarded(async () => sessionResult(await send('/refresh', { method: 'POST', csrf: true })));
  },
};
