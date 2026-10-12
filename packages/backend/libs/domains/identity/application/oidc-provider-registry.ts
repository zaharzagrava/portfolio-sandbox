import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { Domain_OidcProviderUnavailableError } from '../domain/errors';
import type { LinkTrust } from '../domain/link-decision';
import type { OidcProviderSettings } from '../domain/ports';

export type { OidcProviderSettings };

export interface ResolvedProvider {
  id: string;
  displayName: string;
  /** What the provider's claims may be believed for (FR-066). */
  trust: LinkTrust;
  /** A provider registered by a domain (its issuer is tenant-controlled): failures to reach it answer as unknown. */
  dynamic: boolean;
  settings: OidcProviderSettings;
}

export type OidcProviderResolver = (
  providerId: string,
) => Promise<OidcProviderSettings | undefined>;

const GOOGLE_ISSUER = 'https://accounts.google.com';
const PROVIDER_ID = /^[a-z0-9][a-z0-9:_-]{0,99}$/i;
const MAX_FIELD = 2048;

/**
 * The sign-in providers the platform knows: Google from configuration (e-mail claims trusted when the provider
 * verified them) and the providers other domains register through a resolver for a reserved name prefix (shops'
 * enterprise IdPs, S03). A registered provider is believed for its subject only, never for an e-mail address (FR-066,
 * FR-070). Names outside the id shape are unknown before anything is looked up.
 */
@Injectable()
export class OidcProviderRegistry {
  private readonly resolvers = new Map<string, OidcProviderResolver>();
  private readonly listeners = new Set<(providerId: string) => void>();

  constructor(private readonly config: ApiConfigService) {}

  /** Registers the resolver of every provider id that starts with `prefix`. Throws at registration, i.e. at startup. */
  registerResolver(prefix: string, resolver: OidcProviderResolver): void {
    if (
      prefix === '' ||
      prefix.startsWith('google') ||
      'google'.startsWith(prefix)
    )
      throw new Error(`OIDC resolver prefix "${prefix}" is reserved`);
    if (this.resolvers.has(prefix))
      throw new Error(`OIDC resolver prefix "${prefix}" is already registered`);
    for (const known of this.resolvers.keys())
      if (known.startsWith(prefix) || prefix.startsWith(known))
        throw new Error(`OIDC resolver prefix "${prefix}" overlaps "${known}"`);
    this.resolvers.set(prefix, resolver);
  }

  /** The provider's settings changed: whatever is cached for it (discovery, key set) is dropped. */
  invalidate(providerId: string): void {
    for (const listener of this.listeners) listener(providerId);
  }

  /** For the engine that caches provider documents. */
  onInvalidate(listener: (providerId: string) => void): void {
    this.listeners.add(listener);
  }

  /** Enabled static providers, for the sign-in page. */
  list(): Array<{ id: string; displayName: string }> {
    const google = this.google();
    return google ? [{ id: google.id, displayName: google.displayName }] : [];
  }

  /**
   * `undefined` for an unknown, disabled or malformed provider. A resolver that fails is a provider outage
   * (`oidc_provider_unavailable`), never a 500.
   */
  async resolve(providerId: string): Promise<ResolvedProvider | undefined> {
    if (providerId === 'google') return this.google();
    if (!PROVIDER_ID.test(providerId)) return undefined;
    const prefix = [...this.resolvers.keys()].find((p) =>
      providerId.startsWith(p),
    );
    if (prefix === undefined) return undefined;

    let settings: OidcProviderSettings | undefined;
    try {
      settings = await this.resolvers.get(prefix)!(providerId);
    } catch {
      throw new Domain_OidcProviderUnavailableError();
    }
    const valid = validSettings(settings);
    if (!valid) return undefined;
    return {
      id: providerId,
      displayName: providerId,
      trust: 'subject-only',
      dynamic: true,
      settings: valid,
    };
  }

  private google(): ResolvedProvider | undefined {
    const clientId = this.config.get('google_oidc_client_id');
    const clientSecret = this.config.get('google_oidc_client_secret');
    if (!clientId || !clientSecret) return undefined;
    return {
      id: 'google',
      displayName: 'Google',
      trust: 'verified-email',
      dynamic: false,
      settings: {
        issuer: this.config.get('google_oidc_issuer') || GOOGLE_ISSUER,
        clientId,
        clientSecret,
      },
    };
  }
}

/** A resolver's answer is untrusted input: the right shape, bounded, with a parseable issuer URL. */
function validSettings(
  value: OidcProviderSettings | undefined,
): OidcProviderSettings | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { issuer, clientId, clientSecret, scope } = value;
  for (const field of [issuer, clientId, clientSecret])
    if (typeof field !== 'string' || !field || field.length > MAX_FIELD)
      return undefined;
  if (scope !== undefined && (typeof scope !== 'string' || scope.length > 512))
    return undefined;
  try {
    new URL(issuer);
  } catch {
    return undefined;
  }
  return { issuer, clientId, clientSecret, ...(scope && { scope }) };
}
