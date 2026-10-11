import { cookies } from 'next/headers';
import { serverApiUrl } from '@/lib/api/catalog';

/**
 * Stand-in for the session cookie the core API no longer sets (S01 answers the refresh token in the body). The route
 * handlers under `app/api/auth/*` relay the credential calls and keep the refresh token in an HttpOnly cookie of this
 * origin, so the page never sees it and a reload can restore the session. W01 replaces this with the BFF session.
 */
export const REFRESH_COOKIE = 'refresh_token';
const MAX_AGE_SEC = 30 * 24 * 60 * 60;

const noStore = { 'cache-control': 'no-store', pragma: 'no-cache' };

/** Cookie-authenticated calls must come from this origin: SameSite=Lax alone does not cover same-site siblings. */
function foreignOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && new URL(origin).host !== request.headers.get('host');
}

async function setRefreshCookie(request: Request, token: string | null) {
  const store = await cookies();
  if (token === null) {
    store.delete(REFRESH_COOKIE);
    return;
  }
  store.set(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(request.url).protocol === 'https:',
    path: '/',
    maxAge: MAX_AGE_SEC,
  });
}

interface RelayOptions {
  /** Take the refresh token from the cookie instead of the request body (the refresh call). */
  fromCookie?: boolean;
}

interface Upstream {
  status: number;
  contentType: string;
  payload: unknown;
}

/**
 * Refresh tokens are one-time-use and the core API revokes the session when a spent one comes back. A page that is left
 * while its refresh is in flight (a quick navigation or reload) rotates the token upstream but never receives the new
 * cookie, so its next refresh would present the spent token and sign the member out. Calls carrying the same cookie
 * therefore share one upstream rotation, and its answer is replayed for a few seconds (best effort, per instance).
 */
const REPLAY_MS = 10_000;
const rotations = new Map<string, { at: number; result: Promise<Upstream> }>();

function rotateOnce(token: string, run: () => Promise<Upstream>): Promise<Upstream> {
  const now = Date.now();
  for (const [key, entry] of rotations) if (now - entry.at > REPLAY_MS) rotations.delete(key);
  const known = rotations.get(token);
  if (known) return known.result;
  const result = run();
  rotations.set(token, { at: now, result });
  // A failed rotation is not replayed: the next call asks upstream again.
  result.then(
    (r) => r.status >= 400 && rotations.delete(token),
    () => rotations.delete(token),
  );
  return result;
}

/** Forwards a credential call to the core API; a refresh token in the answer moves into the cookie. */
export async function relay(request: Request, path: string, options: RelayOptions = {}): Promise<Response> {
  if (foreignOrigin(request)) {
    return Response.json({ code: 'forbidden', title: 'Forbidden', status: 403 }, { status: 403, headers: noStore });
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const name of ['authorization', 'user-agent', 'x-forwarded-for']) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  let body: string;
  let cookieToken: string | undefined;
  if (options.fromCookie) {
    const refreshToken = (await cookies()).get(REFRESH_COOKIE)?.value;
    cookieToken = refreshToken;
    // A visitor with no session asks on every page load: answer here instead of spending the core API's refresh budget.
    if (!refreshToken) {
      return Response.json({ code: 'unauthenticated', title: 'Unauthorized', status: 401 }, { status: 401, headers: noStore });
    }
    body = JSON.stringify({ refreshToken });
  } else {
    body = await request.text();
  }

  const call = async (): Promise<Upstream> => {
    const res = await fetch(`${serverApiUrl()}${path}`, { method: 'POST', headers, body, cache: 'no-store' });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: pass through untouched
    }
    return { status: res.status, contentType: res.headers.get('content-type') ?? 'application/json', payload: parsed };
  };
  const upstream = cookieToken ? await rotateOnce(cookieToken, call) : await call();
  let payload = upstream.payload;

  if (upstream.status >= 200 && upstream.status < 300 && payload && typeof payload === 'object' && 'refreshToken' in payload) {
    const { refreshToken, ...rest } = payload as { refreshToken: string };
    await setRefreshCookie(request, refreshToken);
    payload = rest;
  } else if (options.fromCookie && (upstream.status === 401 || upstream.status === 403)) {
    await setRefreshCookie(request, null);
  }
  return new Response(payload === null ? null : typeof payload === 'string' ? payload : JSON.stringify(payload), {
    status: upstream.status,
    headers: { 'content-type': upstream.contentType, ...noStore },
  });
}

export async function clearRefreshCookie(request: Request) {
  await setRefreshCookie(request, null);
}
