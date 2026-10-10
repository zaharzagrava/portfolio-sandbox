import { Controller, Get, Header } from '@nestjs/common';
import { RateLimitExempt } from '@app/infrastructure/rate-limit';
import { KeyStore } from '../infra/keys/key-store.service';

/**
 * JWKS (RFC 7517) - the public half of every NEXT/ACTIVE/RETIRED signing key.
 * The edge worker and every service verify access tokens locally from this
 * (cached), so token verification never calls the auth service.
 */
@RateLimitExempt(
  'public key set fetched by every verifier; cacheable and cheap',
)
@Controller('.well-known')
export class WellKnownController {
  constructor(private readonly keys: KeyStore) {}

  @Get('jwks.json')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
  jwks() {
    return this.keys.jwks();
  }
}
