import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import {
  Domain_OidcProviderNotFoundError,
  Domain_OidcProviderUnavailableError,
} from '../domain/errors';
import { parseReturnPath } from '../domain/return-path';
import {
  OIDC_FLOW_STORE,
  OIDC_PROVIDER,
  OidcProviderError,
  type OidcFlowStore,
  type OidcProviderPort,
} from '../domain/ports';
import { OidcProviderRegistry } from './oidc-provider-registry';

export const FLOW_TTL_SEC = 600;

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
const random = (bytes: number): string =>
  randomBytes(bytes).toString('base64url');

/** The redirect URI registered at the provider: the API's callback route for that provider. */
export function redirectUriFor(
  config: ApiConfigService,
  provider: string,
): string {
  const base = (config.get('auth_redirect_base_url') ?? '').replace(/\/$/, '');
  return `${base}/api/auth/oidc/${provider}/callback`;
}

/**
 * Starting a sign-in: a fresh `state`, `nonce` and PKCE verifier, bound to the initiating browser by a random cookie
 * value whose digest is stored with them (login CSRF defence, FR-042). The record is written only after the
 * provider's URL could be built, so a provider outage leaves nothing behind.
 */
@Injectable()
export class OidcFlowService {
  constructor(
    private readonly registry: OidcProviderRegistry,
    @Inject(OIDC_PROVIDER) private readonly provider: OidcProviderPort,
    @Inject(OIDC_FLOW_STORE) private readonly store: OidcFlowStore,
    private readonly config: ApiConfigService,
  ) {}

  async start(input: {
    provider: string;
    returnTo?: string;
    purpose: 'login' | 'link';
    userId?: string;
  }): Promise<{ authorizationUrl: string; flowCookie: string }> {
    const resolved = await this.registry.resolve(input.provider);
    if (!resolved) throw new Domain_OidcProviderNotFoundError();
    const returnPath = parseReturnPath(input.returnTo ?? '/') ?? '/';

    const state = random(32);
    const nonce = random(32);
    const verifier = random(32);
    const flowCookie = random(32);
    let authorizationUrl: string;
    try {
      authorizationUrl = await this.provider.authorizationUrl(
        resolved.id,
        resolved.settings,
        {
          state,
          nonce,
          challenge: createHash('sha256').update(verifier).digest('base64url'),
          redirectUri: redirectUriFor(this.config, resolved.id),
        },
      );
    } catch (error) {
      if (error instanceof OidcProviderError)
        throw new Domain_OidcProviderUnavailableError();
      throw error;
    }

    await this.store.put(
      sha256Hex(state),
      {
        provider: resolved.id,
        purpose: input.purpose,
        ...(input.userId && { userId: input.userId }),
        verifier,
        nonce,
        returnPath,
        cookieDigest: sha256Hex(flowCookie),
      },
      FLOW_TTL_SEC,
    );
    return { authorizationUrl, flowCookie };
  }
}
