import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_TYP,
} from '../domain/token-verifier';
import { ACCESS_TOKEN_TTL_SEC } from '../domain/session-policy';
import type { Role } from '../infra/models/user.model';
import { KeyStore } from '../infra/keys/key-store.service';

/**
 * Signs access tokens (FR-021): ES256, `typ: at+jwt`, `aud: marketplace-api`, 300 s, no personal data. The one signer,
 * so the session issuer and the test fixture produce byte-for-byte the same profile.
 */
@Injectable()
export class AccessTokenSigner {
  constructor(private readonly keys: KeyStore) {}

  async sign(input: {
    userId: string;
    role: Role;
    sessionId: string;
    amr: string[];
  }): Promise<{ token: string; expiresIn: number }> {
    const token = await this.keys.sign(
      {
        sub: input.userId,
        sid: input.sessionId,
        role: input.role,
        amr: input.amr,
      },
      {
        expiresInSec: ACCESS_TOKEN_TTL_SEC,
        audience: ACCESS_TOKEN_AUDIENCE,
        typ: ACCESS_TOKEN_TYP,
        jwtId: uuidv7(),
      },
    );
    return { token, expiresIn: ACCESS_TOKEN_TTL_SEC };
  }
}
