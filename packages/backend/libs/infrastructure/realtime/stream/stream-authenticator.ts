import { Injectable } from '@nestjs/common';

/** The authenticated principal of a stream request: claims only (S51 FR-011). */
export interface StreamPrincipal {
  userId: string;
  roles: string[];
}

/** The credential presented with the request did not verify (invalid, expired, wrongly scoped): answered `401`. */
export class StreamInvalidCredentialError extends Error {
  constructor() {
    super('invalid credential');
    this.name = 'StreamInvalidCredentialError';
  }
}

/**
 * Port to the platform's token verification. The lib is domain-agnostic (X.5), so identity registers its adapter on
 * module init, the way domains register topics. `null` = no credential presented (anonymous); a credential that
 * does not verify throws `StreamInvalidCredentialError`, even for public topics (FR-010).
 */
export interface StreamAuthenticator {
  authenticate(request: {
    headers: Record<string, string | string[] | undefined>;
  }): Promise<StreamPrincipal | null>;
}

@Injectable()
export class StreamAuthenticatorRegistry {
  private authenticator?: StreamAuthenticator;

  register(authenticator: StreamAuthenticator): void {
    if (this.authenticator && this.authenticator !== authenticator)
      throw new Error('a realtime stream authenticator is already registered');
    this.authenticator = authenticator;
  }

  async authenticate(
    request: Parameters<StreamAuthenticator['authenticate']>[0],
  ): Promise<StreamPrincipal | null> {
    return this.authenticator ? this.authenticator.authenticate(request) : null;
  }

  get registered(): boolean {
    return !!this.authenticator;
  }
}
