import { Inject, Injectable } from '@nestjs/common';
import {
  safeRequest,
  SafeRequestError,
  type SafeUrlOptions,
} from '@app/infrastructure/net';
import { TENANCY_NET_OPTIONS, type OidcDiscovery } from '../domain/ports';
import {
  Domain_SsoIssuerInvalidError,
  Domain_SsoIssuerMismatchError,
  Domain_SsoIssuerUnreachableError,
} from '../domain/errors';

export const DISCOVERY_TIMEOUT_MS = 3000;
const MAX_DOCUMENT_BYTES = 256 * 1024;

/** Failures that say "this target is not allowed", as opposed to "the provider did not answer". */
const REFUSED = new Set<SafeRequestError['kind']>([
  'blocked_address',
  'invalid_url',
  'redirect_refused',
  'redirected_host',
  'too_many_redirects',
]);

/**
 * `OIDC_DISCOVERY` over the platform's SSRF-guarded client: https only, public addresses only, no redirects, one
 * attempt within 3 s, the answer capped at 256 KiB. The document must name the issuer it was fetched for.
 */
@Injectable()
export class OidcDiscoveryAdapter implements OidcDiscovery {
  constructor(
    @Inject(TENANCY_NET_OPTIONS)
    private readonly net: SafeUrlOptions & { timeoutMs?: number },
  ) {}

  async verify(issuer: string): Promise<void> {
    const base = issuer.replace(/\/+$/, '');
    let result;
    try {
      result = await safeRequest({
        ...this.net,
        method: 'GET',
        url: `${base}/.well-known/openid-configuration`,
        headers: { accept: 'application/json' },
        timeoutMs: this.net.timeoutMs ?? DISCOVERY_TIMEOUT_MS,
        maxResponseBytes: MAX_DOCUMENT_BYTES,
        allowedPorts: this.net.allowedPorts ?? [443],
        followRedirects: false,
      });
    } catch (error) {
      if (error instanceof SafeRequestError && REFUSED.has(error.kind))
        throw new Domain_SsoIssuerInvalidError();
      throw new Domain_SsoIssuerUnreachableError();
    }
    if (result.status !== 200 || result.truncated)
      throw new Domain_SsoIssuerUnreachableError();
    let document: unknown;
    try {
      document = JSON.parse(result.body);
    } catch {
      throw new Domain_SsoIssuerUnreachableError();
    }
    const named = (document as { issuer?: unknown } | null)?.issuer;
    if (typeof named !== 'string') throw new Domain_SsoIssuerUnreachableError();
    if (named.replace(/\/+$/, '') !== base)
      throw new Domain_SsoIssuerMismatchError();
  }
}
