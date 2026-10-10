import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import type { LinkTrust } from '../domain/link-decision';
import type { OidcProviderSettings } from '../domain/ports';

export interface ResolvedProvider {
  id: string;
  displayName: string;
  /** What the provider's claims may be believed for (FR-066). */
  trust: LinkTrust;
  settings: OidcProviderSettings;
}

const GOOGLE_ISSUER = 'https://accounts.google.com';

/**
 * The sign-in providers the platform knows: Google from configuration (e-mail claims trusted when the provider
 * verified them). Names outside the `google` / `shop:<uuid>` shapes are unknown before anything is looked up.
 * Shop identity providers (S03) register through this class in the later US8 pass.
 */
@Injectable()
export class OidcProviderRegistry {
  constructor(private readonly config: ApiConfigService) {}

  /** Enabled static providers, for the sign-in page. */
  list(): Array<{ id: string; displayName: string }> {
    const google = this.google();
    return google ? [{ id: google.id, displayName: google.displayName }] : [];
  }

  resolve(providerId: string): Promise<ResolvedProvider | undefined> {
    return Promise.resolve(providerId === 'google' ? this.google() : undefined);
  }

  private google(): ResolvedProvider | undefined {
    const clientId = this.config.get('google_oidc_client_id');
    const clientSecret = this.config.get('google_oidc_client_secret');
    if (!clientId || !clientSecret) return undefined;
    return {
      id: 'google',
      displayName: 'Google',
      trust: 'verified-email',
      settings: {
        issuer: this.config.get('google_oidc_issuer') || GOOGLE_ISSUER,
        clientId,
        clientSecret,
      },
    };
  }
}
