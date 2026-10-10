import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import type { AuthenticatedUser } from '../domain/authenticated-user';
import { Domain_InvalidTokenError } from '../domain/errors';
import {
  peekKid,
  verifyAccessToken,
  verifyPurposeToken,
  type TokenClaims,
} from '../domain/token-verifier';
import { KeyStore } from '../infra/keys/key-store.service';

/**
 * Token verification for every app (no user lookup, no store but the cached key set). The principal comes from the
 * token's claims alone (FR-023).
 */
@Injectable()
export class TokenAuthService {
  constructor(
    private readonly keys: KeyStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async authenticate(token: string): Promise<AuthenticatedUser> {
    const key = await this.keyFor(token);
    return verifyAccessToken(token, key, this.clock.now());
  }

  /** MFA challenge and service tokens. */
  async verifyPurpose(
    token: string,
    expected: { typ: string; aud: string },
  ): Promise<TokenClaims> {
    const key = await this.keyFor(token);
    return verifyPurposeToken(token, key, this.clock.now(), expected);
  }

  private async keyFor(token: string) {
    const resolved = await this.keys.verificationKey(peekKid(token));
    if (!resolved) throw new Domain_InvalidTokenError('unknown_kid');
    return resolved.key;
  }
}
