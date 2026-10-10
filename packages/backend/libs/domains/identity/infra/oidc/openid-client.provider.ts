import { Inject, Injectable, Optional } from '@nestjs/common';
import * as client from 'openid-client';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import { parseSafeUrl } from '@app/infrastructure/net/safe-url';
import {
  OIDC_NET_OPTIONS,
  OidcProviderError,
  type OidcProviderPort,
  type OidcProviderSettings,
} from '../../domain/ports';
import { guardedFetch, type OidcNetOptions } from './guarded-fetch';
import { IdTokenSignatureVerifier } from './id-token-signature';

const DISCOVERY_TTL_MS = 3_600_000;
const ALLOWED_ALGS = ['RS256', 'ES256', 'PS256', 'EdDSA'] as const;
const CLOCK_TOLERANCE_SEC = 5;
export const OIDC_SCOPE = 'openid email profile';

interface Provider {
  config: client.Configuration;
  alg: string;
  jwksUri: string;
  signatures: IdTokenSignatureVerifier;
}

interface Cached extends Provider {
  at: number;
}

/** Error codes of the library that mean "the ID token is not acceptable" (the rest of a failed exchange is `exchange`). */
const TOKEN_CODES = new Set([
  'OAUTH_JWT_CLAIM_COMPARISON_FAILED',
  'OAUTH_JWT_TIMESTAMP_CHECK_FAILED',
  'OAUTH_KEY_SELECTION_FAILED',
  'OAUTH_UNSUPPORTED_OPERATION',
  'OAUTH_INVALID_RESPONSE',
  'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED',
]);

/**
 * `OIDC_PROVIDER` over `openid-client`, with every request routed through the guarded fetch. Discovery is read and
 * checked here (issuer equality, https endpoints, a pinned signing algorithm) and cached for an hour per provider;
 * the library then does the code exchange and validates the ID token (signature, `iss`, `aud`/`azp`, `exp` with 5 s
 * tolerance, `nonce`). Provider tokens are used inside `exchange` and dropped; nothing here stores or logs them.
 *
 * R-09 outcome: the library does not check an ID token's signature when the token came from the token endpoint, and its
 * own key-set cache (5 min, 60 s reload) cannot be bounded to FR-046; so signatures are checked by
 * `IdTokenSignatureVerifier` (key set cached 1 h, at most one reload per 30 s on an unknown key) and the discovery
 * document is cached here for 1 h.
 */
@Injectable()
export class OpenidClientProvider implements OidcProviderPort {
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<Provider>>();
  private readonly clock: Clock;
  private readonly net: OidcNetOptions;

  constructor(
    @Optional() @Inject(OIDC_NET_OPTIONS) net?: OidcNetOptions,
    @Optional() @Inject(CLOCK) clock?: Clock,
  ) {
    this.net = net ?? {};
    this.clock = clock ?? new SystemClock();
  }

  /** Drops the cached discovery of a provider (a changed configuration). */
  invalidate(providerId: string): void {
    for (const key of [...this.cache.keys()])
      if (key.startsWith(`${providerId}|`)) this.cache.delete(key);
  }

  async authorizationUrl(
    provider: string,
    settings: OidcProviderSettings,
    input: {
      state: string;
      nonce: string;
      challenge: string;
      redirectUri: string;
    },
  ): Promise<string> {
    const { config } = await this.configuration(provider, settings);
    return client
      .buildAuthorizationUrl(config, {
        redirect_uri: input.redirectUri,
        scope: OIDC_SCOPE,
        code_challenge: input.challenge,
        code_challenge_method: 'S256',
        state: input.state,
        nonce: input.nonce,
        response_type: 'code',
      })
      .toString();
  }

  async exchange(
    provider: string,
    settings: OidcProviderSettings,
    input: {
      code: string;
      state: string;
      verifier: string;
      nonce: string;
      redirectUri: string;
    },
  ): Promise<Record<string, unknown>> {
    const known = await this.configuration(provider, settings);
    const callback = new URL(input.redirectUri);
    callback.searchParams.set('code', input.code);
    callback.searchParams.set('state', input.state);
    try {
      const tokens = await client.authorizationCodeGrant(
        known.config,
        callback,
        {
          pkceCodeVerifier: input.verifier,
          expectedState: input.state,
          expectedNonce: input.nonce,
          idTokenExpected: true,
        },
      );
      const claims = tokens.claims();
      if (!claims || !tokens.id_token) throw new OidcProviderError('token');
      // The library trusts a token that came from the token endpoint; we also check the signature (FR-043).
      await known.signatures.verify(known.jwksUri, tokens.id_token, known.alg);
      return { ...claims };
    } catch (error) {
      // The library wraps whatever our fetch threw as the `cause` of its own error.
      for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
        if (e instanceof OidcProviderError) throw e;
        e = (e as { cause?: unknown }).cause;
      }
      const code = (error as { code?: string } | null)?.code;
      throw new OidcProviderError(
        code && TOKEN_CODES.has(code) ? 'token' : 'exchange',
      );
    }
  }

  private async configuration(
    provider: string,
    settings: OidcProviderSettings,
  ): Promise<Provider> {
    const key = `${provider}|${settings.issuer}|${settings.clientId}`;
    const now = this.clock.nowMs();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < DISCOVERY_TTL_MS) return hit;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.discover(settings)
        .then((found) => {
          this.cache.set(key, { ...found, at: now });
          return found;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async discover(settings: OidcProviderSettings): Promise<Provider> {
    const fetcher = guardedFetch(this.net);
    const base = settings.issuer.replace(/\/$/, '');
    const response = await fetcher(`${base}/.well-known/openid-configuration`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (response.status !== 200) throw new OidcProviderError('unavailable');
    let metadata: client.ServerMetadata;
    try {
      metadata = (await response.json()) as client.ServerMetadata;
    } catch {
      throw new OidcProviderError('unavailable');
    }

    // The document must be about the issuer it was fetched for, and point only at endpoints we may call.
    if (metadata?.issuer !== settings.issuer)
      throw new OidcProviderError('unavailable');
    try {
      for (const endpoint of [
        metadata.authorization_endpoint,
        metadata.token_endpoint,
        metadata.jwks_uri,
      ]) {
        if (typeof endpoint !== 'string')
          throw new OidcProviderError('unavailable');
        parseSafeUrl(endpoint, this.net);
      }
    } catch {
      throw new OidcProviderError('unavailable');
    }

    // Never `none`, never a symmetric algorithm: pin one the provider advertises from a short asymmetric list.
    const advertised = metadata.id_token_signing_alg_values_supported ?? [];
    const alg = ALLOWED_ALGS.find((a) => advertised.includes(a)) ?? undefined;
    if (!alg) throw new OidcProviderError('unavailable');

    const config = new client.Configuration(
      metadata,
      settings.clientId,
      {
        id_token_signed_response_alg: alg,
        [client.clockTolerance]: CLOCK_TOLERANCE_SEC,
      },
      client.ClientSecretPost(settings.clientSecret),
    );
    config[client.customFetch] = fetcher as client.CustomFetch;
    const httpHost = (host: string) =>
      this.net.allowHttpHosts?.includes(host) ?? false;
    if (httpHost(new URL(settings.issuer).hostname))
      client.allowInsecureRequests(config);
    return {
      config,
      alg,
      jwksUri: metadata.jwks_uri as string,
      signatures: new IdTokenSignatureVerifier(fetcher, this.clock),
    };
  }
}
