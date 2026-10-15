import { isValidRefCode, REF_COOKIE, REF_MAX_AGE_SECONDS } from '@/lib/attribution/ref-code';

/**
 * `POST /api/attribution/ref {code}` (W02 AS-63, FR-124): sets the first-party `__Host-ref` cookie from the product page's
 * `?ref=`. It sits in the file system, so it wins over the `/api/:path*` rewrite to the BFF. Same-origin callers only (the
 * `Origin` header must be this origin); an invalid code, a body that is not JSON or a foreign origin change nothing. It
 * reads and sets no other cookie.
 */

const MAX_BODY = 1024;
const NO_STORE = { 'Cache-Control': 'no-store' };

const refuse = (status: number) => new Response(null, { status, headers: NO_STORE });

/** The caller's `Origin` must name the host this request was addressed to (behind a TLS-terminating proxy the scheme differs). */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwarded || request.headers.get('host') || new URL(request.url).host;
  return originHost === host;
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return refuse(403);

  let code: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return refuse(400);
    const body: unknown = JSON.parse(text);
    code = body !== null && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
  } catch {
    return refuse(400);
  }
  if (!isValidRefCode(code)) return refuse(400);

  return new Response(null, {
    status: 204,
    headers: {
      ...NO_STORE,
      'Set-Cookie': `${REF_COOKIE}=${code}; Path=/; Max-Age=${REF_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}
