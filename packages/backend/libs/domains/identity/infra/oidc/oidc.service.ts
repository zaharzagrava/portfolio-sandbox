import { Injectable, Logger } from '@nestjs/common';
import * as client from 'openid-client';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ApiConfigService } from '@app/common/config/api-config.service';

export interface OidcProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

export interface OidcIdentity {
  provider: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}

const STATE_TTL_SEC = 600;

/**
 * OpenID Connect login (lesson 05/02 §4): Authorization Code + PKCE (S256),
 * `state` (CSRF on the callback) and `nonce` (ID-token replay), all bound to
 * one login attempt in Redis for 10 minutes. Providers: Google from config,
 * plus dynamically registered ones (per-shop enterprise IdPs, SD-02).
 */
@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private readonly providers = new Map<string, OidcProviderConfig>();
  private readonly discovered = new Map<string, client.Configuration>();

  constructor(
    private readonly redis: RedisService,
    private readonly config: ApiConfigService,
  ) {
    const googleId = config.get('google_oidc_client_id');
    if (googleId) {
      this.register('google', {
        issuer: 'https://accounts.google.com',
        clientId: googleId,
        clientSecret: config.get('google_oidc_client_secret') ?? '',
      });
    }
  }

  private resolver?: (provider: string) => Promise<OidcProviderConfig | undefined>;

  /** Dynamic providers, e.g. `shop:<id>` enterprise IdPs loaded from ShopSsoConfig (SD-02). */
  setResolver(resolver: (provider: string) => Promise<OidcProviderConfig | undefined>): void {
    this.resolver = resolver;
  }

  register(name: string, provider: OidcProviderConfig): void {
    this.providers.set(name, provider);
    this.discovered.delete(name);
  }

  redirectUri(provider: string): string {
    return `${this.config.get('auth_redirect_base_url') ?? this.config.get('backend_host')}/api/auth/oidc/${provider}/callback`;
  }

  async start(provider: string, returnTo = '/'): Promise<string> {
    const configuration = await this.configuration(provider);
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();

    await this.redis.client.set(`oidc:state:${state}`, JSON.stringify({ provider, codeVerifier, nonce, returnTo }), 'EX', STATE_TTL_SEC);

    return client
      .buildAuthorizationUrl(configuration, {
        redirect_uri: this.redirectUri(provider),
        scope: this.providers.get(provider)?.scope ?? 'openid email profile',
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      })
      .toString();
  }

  /** Validates state (single use), exchanges the code, verifies the ID token (sig, iss, aud, exp, nonce). */
  async callback(provider: string, currentUrl: URL): Promise<{ identity: OidcIdentity; returnTo: string }> {
    const state = currentUrl.searchParams.get('state') ?? '';
    const raw = await this.redis.client.getdel(`oidc:state:${state}`);
    if (!raw) throw new Error('unknown or expired OIDC state');
    const saved = JSON.parse(raw) as { provider: string; codeVerifier: string; nonce: string; returnTo: string };
    if (saved.provider !== provider) throw new Error('OIDC state/provider mismatch');

    const tokens = await client.authorizationCodeGrant(await this.configuration(provider), currentUrl, {
      pkceCodeVerifier: saved.codeVerifier,
      expectedState: state,
      expectedNonce: saved.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims()!;

    return {
      identity: {
        provider,
        subject: claims.sub,
        email: typeof claims.email === 'string' ? claims.email.toLowerCase() : undefined,
        emailVerified: claims.email_verified === true,
        name: typeof claims.name === 'string' ? claims.name : undefined,
      },
      returnTo: saved.returnTo,
    };
  }

  private async configuration(provider: string): Promise<client.Configuration> {
    const cached = this.discovered.get(provider);
    if (cached) return cached;
    let settings = this.providers.get(provider);
    if (!settings && this.resolver) {
      settings = await this.resolver(provider);
      if (settings) this.providers.set(provider, settings);
    }
    if (!settings) throw new Error(`unknown OIDC provider ${provider}`);
    const configuration = await client.discovery(new URL(settings.issuer), settings.clientId, settings.clientSecret);
    this.discovered.set(provider, configuration);
    return configuration;
  }
}
