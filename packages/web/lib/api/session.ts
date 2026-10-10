/**
 * Browser session through the BFF (token handler, S48 contracts/http.md). The browser never reads or stores a token:
 * it holds an HttpOnly `__Host-bff-session` cookie and a readable `__Host-bff-csrf` cookie that is echoed in
 * `X-CSRF-Token` on cookie-authenticated `POST`s. The API and the web app share one origin (`next.config.ts` rewrites
 * `/api/bff/*`), which is what makes the `__Host-` cookies valid.
 *
 * Callers switch on the problem `code`, never on message text. Shapes mirror `packages/contracts/src/bff/session.ts`
 * (this package does not depend on the contracts workspace yet).
 */
export type SessionRole = 'USER' | 'SELLER' | 'MODERATOR' | 'ADMIN';

export interface SessionView {
  user: { id: string; email: string | null; role: SessionRole };
  /** ISO-8601: when the session ends if it stays idle. */
  expiresAt: string;
}

export type SessionResult =
  | { ok: true; kind: 'session'; session: SessionView }
  | { ok: true; kind: 'mfa_required' }
  | { ok: true; kind: 'signed_out' }
  | {
      ok: false;
      status: number;
      /** The BFF's / identity service's problem `code`; `unknown` when the answer carried none. */
      code: string;
      retryAfterSeconds?: number;
    };

const BASE = '/api/bff/session';
export const CSRF_COOKIE = '__Host-bff-csrf';
export const CSRF_HEADER = 'X-CSRF-Token';

function csrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

/** `{ 'X-CSRF-Token': <cookie value> }` when the readable CSRF cookie is present, else nothing. */
export function csrfHeader(): Record<string, string> {
  const token = csrfToken();
  return token ? { [CSRF_HEADER]: token } : {};
}

async function failure(res: Response): Promise<SessionResult> {
  let code = 'unknown';
  try {
    const body = (await res.json()) as { code?: unknown };
    if (typeof body.code === 'string') code = body.code;
  } catch {
    /* no problem document: keep `unknown` */
  }
  const retry = Number(res.headers.get('retry-after'));
  return {
    ok: false,
    status: res.status,
    code,
    ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
  };
}

async function send(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; csrf?: boolean },
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.csrf) Object.assign(headers, csrfHeader());
  return fetch(`${BASE}${path}`, {
    method: init.method,
    headers,
    credentials: 'include',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function sessionResult(res: Response): Promise<SessionResult> {
  if (!res.ok) return failure(res);
  const body = (await res.json()) as Partial<SessionView> & { mfaRequired?: boolean };
  if (body.mfaRequired === true) return { ok: true, kind: 'mfa_required' };
  return { ok: true, kind: 'session', session: body as SessionView };
}

export const sessionApi = {
  /** Password login. `mfa_required` means: ask for the second factor and call `verifyMfa`. */
  async login(email: string, password: string): Promise<SessionResult> {
    return sessionResult(await send('', { method: 'POST', body: { email, password } }));
  },

  async verifyMfa(code: string): Promise<SessionResult> {
    return sessionResult(await send('/mfa', { method: 'POST', body: { code } }));
  },

  /** The signed-in user, or a `401` problem (`unauthenticated`, `session_expired`). */
  async current(): Promise<SessionResult> {
    return sessionResult(await send('', { method: 'GET' }));
  },

  /** Idempotent: always ends signed out unless the CSRF check fails. */
  async logout(): Promise<SessionResult> {
    const res = await send('/logout', { method: 'POST', csrf: true });
    return res.ok ? { ok: true, kind: 'signed_out' } : failure(res);
  },
};
