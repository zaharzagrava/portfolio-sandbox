import { safeRequest, SafeRequestError } from '@app/infrastructure/net';
import type { SafeUrlOptions } from '@app/infrastructure/net';
import { MAX_ID_TOKEN_BYTES } from '../../domain/id-token-claims';
import { OidcProviderError } from '../../domain/ports';

export type OidcNetOptions = SafeUrlOptions & {
  /** Per provider request, default 3 s (FR-046). */
  timeoutMs?: number;
};

export const OIDC_TIMEOUT_MS = 3000;
export const OIDC_MAX_RESPONSE_BYTES = 1024 * 1024;

interface FetchInit {
  body?: unknown;
  headers: Record<string, string>;
  method: string;
}

const flatten = (headers: Record<string, string | string[] | undefined>) => {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (
      ['content-length', 'content-encoding', 'transfer-encoding'].includes(name)
    )
      continue;
    out.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return out;
};

/**
 * Every request to an identity provider goes through the platform's SSRF-guarded client (FR-046, FR-071): HTTPS to
 * allowed ports, public addresses only, no redirects, 3 s deadline, 1 MiB cap. The code exchange is never retried.
 * Failures are typed (`OidcProviderError`): no URL, address or provider text survives into a message.
 */
export function guardedFetch(net: OidcNetOptions) {
  return async (url: string, init: FetchInit): Promise<Response> => {
    const body =
      init.body instanceof URLSearchParams
        ? init.body.toString()
        : typeof init.body === 'string'
          ? init.body
          : undefined;
    let result;
    try {
      result = await safeRequest({
        ...net,
        method: init.method,
        url,
        headers: init.headers,
        body,
        timeoutMs: net.timeoutMs ?? OIDC_TIMEOUT_MS,
        maxResponseBytes: OIDC_MAX_RESPONSE_BYTES,
        allowedPorts: net.allowedPorts ?? [443],
        followRedirects: false,
      });
    } catch (error) {
      if (error instanceof SafeRequestError)
        throw new OidcProviderError('unavailable', error.kind === 'timeout');
      throw new OidcProviderError('unavailable');
    }
    // A response cut at the cap is not a document we can trust.
    if (result.truncated) throw new OidcProviderError('exchange');

    if (
      init.method === 'POST' &&
      body?.includes('grant_type=authorization_code')
    )
      inspectCodeExchange(result.status, result.body);

    return new Response(result.body, {
      status: result.status,
      headers: flatten(result.headers),
    });
  };
}

/** The token response must carry an ID token of a sane size before any library looks at it. */
function inspectCodeExchange(status: number, text: string): void {
  if (status < 200 || status >= 300) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return; // not JSON: the library reports it as a failed exchange
  }
  const idToken = (parsed as { id_token?: unknown } | null)?.id_token;
  if (typeof idToken !== 'string' || idToken.length === 0)
    throw new OidcProviderError('exchange');
  if (Buffer.byteLength(idToken) > MAX_ID_TOKEN_BYTES)
    throw new OidcProviderError('token');
}
