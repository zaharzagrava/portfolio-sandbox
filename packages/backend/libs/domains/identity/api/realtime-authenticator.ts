import { Injectable } from '@nestjs/common';
import {
  StreamInvalidCredentialError,
  type StreamAuthenticator,
  type StreamPrincipal,
} from '@app/infrastructure/realtime';
import { TokenAuthService } from '../application/token-auth.service';
import { Domain_InvalidTokenError } from '../domain/errors';
import { extractAuthToken } from './guards/extract-auth-token';

/**
 * Credential check of the realtime stream endpoint (S51 FR-010): no credential is anonymous, a presented credential that
 * does not verify is refused even where the topics are public. Registered by `IdentityTopics`; the hub itself knows no
 * identity code.
 */
@Injectable()
export class IdentityStreamAuthenticator implements StreamAuthenticator {
  constructor(private readonly tokens: TokenAuthService) {}

  async authenticate(request: {
    headers: Record<string, string | string[] | undefined>;
  }): Promise<StreamPrincipal | null> {
    const token = extractAuthToken(request);
    if (!token) return null;
    try {
      const user = await this.tokens.authenticate(token);
      return { userId: user.id, roles: [user.role] };
    } catch (error) {
      if (error instanceof Domain_InvalidTokenError)
        throw new StreamInvalidCredentialError();
      throw error;
    }
  }
}
